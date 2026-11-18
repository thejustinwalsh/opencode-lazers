import { sameProject } from "../project-key.ts"
import { panelErrorMessage as errorMessage } from "../panel-error.ts"
import type { TaskDetail, TaskPage } from "../tasks/contract.ts"
import type { TrajectoryResponse } from "../observability/contract.ts"
import { readTaskEffortBasis } from "./comparison-presentation.ts"
import type { ModelEvidenceOutput } from "./source-schema.ts"
import type { ModelComparisonOutput } from "./comparison-schema.ts"
import { ModelCatalogOutputSchema, ModelMappingWriteOutputSchema } from "./contract.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import type {
  ModelMappingRecord,
  ModelMappingTargetInput,
  ModelMappingUpdate,
} from "./mapping-schema.ts"
import type { ModelPolicy, WorkerPersona } from "../runner/schema.ts"
import type {
  ModelDecisionConfigurations,
  ModelDecisionContext,
  ModelDecisionFilters,
  ModelDecisionInspect,
  ModelDecisionOverview,
  ModelDecisionRows,
} from "./decision-contract.ts"

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
export type ModelCatalogOutput = (typeof ModelCatalogOutputSchema)["_output"]

export type ModelAssignmentWrite = {
  status: "saving" | "verifying" | "uncertain" | "conflict" | "confirmed" | "failed"
  persona: WorkerPersona
  target: ModelMappingTargetInput | null
  route: ModelPolicy | null
  expectedRevision: number
  revision: number | null
  message: string
}

export type ModelComparisonTransport = {
  comparison(cursor: string | undefined, signal: AbortSignal): Promise<ModelComparisonOutput>
  refreshSources(signal: AbortSignal): Promise<ModelEvidenceOutput>
  settings(taskID: string | undefined, signal: AbortSignal): Promise<ModelSettingsOutput>
  catalog(signal: AbortSignal): Promise<ModelCatalogOutput>
  configure(update: ModelMappingUpdate, signal: AbortSignal): Promise<ModelMappingWriteOutput>
  queryTasks(signal: AbortSignal): Promise<TaskPage>
  getTask(taskID: string, signal: AbortSignal): Promise<TaskDetail>
  trajectoryStatus(taskID: string, signal: AbortSignal): Promise<TrajectoryResponse>
  decisionOverview?(
    filters: ModelDecisionFilters,
    signal: AbortSignal,
  ): Promise<ModelDecisionOverview>
  decisionRows?(
    filters: ModelDecisionFilters,
    cursor: string | undefined,
    snapshotID: string,
    signal: AbortSignal,
  ): Promise<ModelDecisionRows>
  decisionConfigurations?(
    filters: ModelDecisionFilters,
    cursor: string | undefined,
    snapshotID: string,
    signal: AbortSignal,
  ): Promise<ModelDecisionConfigurations>
  decisionInspect?(
    filters: ModelDecisionFilters,
    snapshotID: string,
    configurationID: string,
    selectedTaskID: string | null,
    contributorCursor: string | undefined,
    signal: AbortSignal,
  ): Promise<ModelDecisionInspect>
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
  decisionFilters: ModelDecisionFilters
  decisionStatus: ModelDecisionStatus
  decisionError: string
  decisionContext?: ModelDecisionContext
  decisionOverview?: ModelDecisionOverview
  decisionRows: ModelDecisionRows["rows"]
  decisionRowsNextCursor: string | null
  decisionRowsLoading: boolean
  decisionConfigurations: ModelDecisionConfigurations["configurations"]
  decisionConfigurationsNextCursor: string | null
  decisionConfigurationsLoading: boolean
  selectedConfigurationID: string | null
  decisionInspection?: Extract<ModelDecisionInspect, { status: "found" }>
  decisionInspectLoading: boolean
  decisionInspectError: string
  decisionNotFound: boolean
  decisionContributorsLoading: boolean
  task?: ModelTask
  effortBasis?: ReturnType<typeof readTaskEffortBasis>
  settings?: ModelSettingsOutput
  catalog?: ModelCatalogOutput
  catalogStatus: "loading" | "ready" | "unavailable"
  catalogError: string
  assignmentWrite?: ModelAssignmentWrite
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
  selectedConfigurationID?: string | null
}

export const emptyModelDecisionFilters: ModelDecisionFilters = {
  persona: null,
  taskKind: null,
  period: { from: null, to: null },
}

function decisionContextMatches(
  actual: ModelDecisionContext,
  filters: ModelDecisionFilters,
  projectDirectory: string,
  snapshotID?: string,
) {
  return (
    actual.scope.projectDirectory === projectDirectory &&
    JSON.stringify(actual.filters) === JSON.stringify(filters) &&
    (snapshotID === undefined || actual.snapshotID === snapshotID)
  )
}

function decisionScopeAndFiltersMatch(
  actual: ModelDecisionContext,
  filters: ModelDecisionFilters,
  projectDirectory: string,
) {
  return (
    actual.scope.projectDirectory === projectDirectory &&
    JSON.stringify(actual.filters) === JSON.stringify(filters)
  )
}

function isExpiredDecisionSnapshot(error: unknown) {
  const message = errorMessage(error)
  return (
    message.includes("Model decision snapshot is unavailable or expired") ||
    message.includes("Model decision cursor is stale or its snapshot expired")
  )
}

function decisionStatus(context: ModelDecisionContext, online: boolean): ModelDecisionStatus {
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

function missingDecisionRPC(error: unknown) {
  return /unknown (?:rpc|method)|rpc (?:not found|not registered|unavailable)|method not found|no (?:rpc|method) handler|not implemented/i.test(
    errorMessage(error),
  )
}

/** Only a snapshot with something to show is worth restoring. */
export function isSeedable(data: ModelComparisonPanelData) {
  return (
    Boolean(data.decisionOverview || data.comparison) &&
    (data.decisionStatus === "ready" || data.decisionStatus === "partial")
  )
}

/** A cached snapshot as the starting point of a new connection: content kept, loading flags reset. */
function seededData(
  seed: ModelComparisonPanelData,
  key: string,
  projectID: string,
  projectDirectory: string,
  preferences: ModelComparisonPreferences,
  decisionFilters: ModelDecisionFilters,
): ModelComparisonPanelData {
  return {
    ...seed,
    key,
    projectID,
    projectDirectory,
    decisionFilters,
    selectedTaskID: preferences.selectedTaskID,
    selectedCandidateID: preferences.selectedCandidateID,
    selectedConfigurationID: preferences.selectedConfigurationID ?? null,
    decisionError: "",
    decisionRowsLoading: false,
    decisionConfigurationsLoading: false,
    decisionInspectLoading: false,
    decisionInspectError: "",
    decisionNotFound: false,
    decisionContributorsLoading: false,
    comparisonLoading: true,
    comparisonError: "",
    comparisonStale: false,
    taskLoading: false,
    taskError: "",
    effortLoading: false,
    effortError: "",
    settingsLoading: true,
    settingsError: "",
    tasksLoading: true,
    tasksError: "",
    catalogStatus: seed.catalogStatus === "ready" ? "ready" : "loading",
    catalogError: "",
    sourceRefresh: "idle",
    sourceRefreshError: "",
    stale: false,
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
    candidates: [],
    selectedCandidateID: preferences.selectedCandidateID,
    tasks: [],
    selectedTaskID: preferences.selectedTaskID,
    decisionFilters,
    decisionStatus: "loading",
    decisionError: "",
    decisionRows: [],
    decisionRowsNextCursor: null,
    decisionRowsLoading: false,
    decisionConfigurations: [],
    decisionConfigurationsNextCursor: null,
    decisionConfigurationsLoading: false,
    selectedConfigurationID: preferences.selectedConfigurationID ?? null,
    decisionInspectLoading: false,
    decisionInspectError: "",
    decisionNotFound: false,
    decisionContributorsLoading: false,
    comparisonLoading: true,
    comparisonError: "",
    comparisonStale: false,
    taskLoading: true,
    taskError: "",
    effortLoading: false,
    effortError: "",
    settingsLoading: true,
    settingsError: "",
    catalogStatus: "loading",
    catalogError: "",
    tasksLoading: true,
    tasksError: "",
    sourceRefresh: "idle",
    sourceRefreshError: "",
    stale: false,
  }
}

/** Coordinates bounded comparison reads and the selected task's actual observation. */
/** Longest the first decision read waits for a source refresh before using saved prices. */
export const SOURCE_WAIT_MS = 10_000

function settleWithin(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export class ModelComparisonPanelState {
  data = blank()
  private controller = new AbortController()
  private taskController = new AbortController()
  private decisionController = new AbortController()
  private inspectionController = new AbortController()
  private generation = 0
  private comparisonRequest = 0
  private comparisonRevision = 0
  private taskRequest = 0
  private selectedTaskLoad?: PendingSelectedTaskLoad
  private settingsRequest = 0
  private catalogRequest = 0
  private selectionRevision = 0
  private assignmentRequest = 0
  private assignmentController = new AbortController()
  private assignmentOperation?: PendingAssignmentWrite
  private transport?: ModelComparisonTransport
  private projectID = ""
  private projectDirectory = ""
  private sourceRefreshPromise?: Promise<void>
  private comparisonPromise?: Promise<void>
  private taskListPromise?: Promise<void>
  private refreshPromise?: Promise<void>
  private comparisonNeedsRefresh = false
  private decisionRequest = 0
  private decisionInspectionRequest = 0
  private decisionRowsRequest = 0
  private decisionConfigurationsRequest = 0
  private decisionContributorsRequest = 0
  private decisionPromise?: Promise<void>
  private decisionNeedsRefresh = false
  private decisionRowsPromise?: Promise<void>
  private decisionConfigurationsPromise?: Promise<void>
  private decisionContributorsPromise?: Promise<void>

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
    /** The last snapshot for this project and filters: shown at once, refreshed in place. */
    seed?: ModelComparisonPanelData,
  ) {
    this.close()
    this.controller = new AbortController()
    this.taskController = new AbortController()
    this.decisionController = new AbortController()
    this.inspectionController = new AbortController()
    this.transport = transport
    this.projectID = projectID
    this.projectDirectory = projectDirectory
    this.data =
      seed && isSeedable(seed)
        ? seededData(seed, key, projectID, projectDirectory, preferences, decisionFilters)
        : blank(key, projectID, projectDirectory, preferences, decisionFilters)
    const generation = this.generation
    const selectionRevision = this.selectionRevision

    // Invoke the cached bounded projection before starting the independent refresh.
    void this.refreshComparison(generation)
    void this.loadTasks(generation, preferences.selectedTaskID ?? undefined)
    void this.loadSettings(generation, preferences.selectedTaskID ?? undefined, selectionRevision)
    void this.loadCatalog(generation)
    void this.refreshSources(generation)
    void this.refreshDecisionSnapshot(generation)
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
        this.comparisonRevision++
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
            selectedConfigurationID: this.data.selectedConfigurationID,
          })
      } catch (error) {
        if (generation === this.generation && request === this.comparisonRequest && !signal.aborted)
          this.update({
            comparisonLoading: false,
            comparisonError: errorMessage(error),
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
    const generation = this.generation
    const signal = this.controller.signal
    const comparisonRevision = this.comparisonRevision
    const before = this.data.candidates.length
    const output = this.data.comparison
    await this.refreshComparison(generation, cursor)
    // The awaited page may belong to a connection that was replaced or hidden.
    // In particular, never let this rollback publish the old connection's cache.
    if (
      generation !== this.generation ||
      signal.aborted ||
      this.comparisonRevision !== comparisonRevision + 1
    )
      return
    const current = this.data.comparison
    if (
      output &&
      current &&
      output.sources.some(
        (source, index) => source.selectedSnapshotID !== current.sources[index]?.selectedSnapshotID,
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
    if (this.refreshPromise) return this.refreshPromise

    const generation = this.generation
    const selectedTaskID = this.data.selectedTaskID
    const selectionRevision = this.selectionRevision
    const operation = Promise.all([
      this.loadTasks(generation, selectedTaskID ?? undefined),
      this.refreshSources(generation),
      this.refreshDecisionSnapshot(generation),
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

  setDecisionFilters(filters: ModelDecisionFilters, seed?: ModelComparisonPanelData) {
    if (JSON.stringify(filters) === JSON.stringify(this.data.decisionFilters)) return
    this.decisionController.abort()
    this.inspectionController.abort()
    this.decisionController = new AbortController()
    this.inspectionController = new AbortController()
    this.decisionRequest++
    this.decisionInspectionRequest++
    this.decisionRowsRequest++
    this.decisionConfigurationsRequest++
    this.decisionContributorsRequest++
    this.decisionPromise = undefined
    this.decisionRowsPromise = undefined
    this.decisionConfigurationsPromise = undefined
    this.decisionContributorsPromise = undefined
    this.decisionNeedsRefresh = false
    if (
      seed &&
      isSeedable(seed) &&
      JSON.stringify(seed.decisionFilters) === JSON.stringify(filters)
    ) {
      // The last result for these filters shows at once; the refresh below replaces it in place.
      this.update({
        decisionFilters: filters,
        decisionStatus: seed.decisionStatus,
        decisionError: "",
        decisionContext: seed.decisionContext,
        decisionOverview: seed.decisionOverview,
        decisionRows: seed.decisionRows,
        decisionRowsNextCursor: seed.decisionRowsNextCursor,
        decisionRowsLoading: false,
        decisionConfigurations: seed.decisionConfigurations,
        decisionConfigurationsNextCursor: seed.decisionConfigurationsNextCursor,
        decisionConfigurationsLoading: false,
        decisionInspection: seed.decisionInspection,
        decisionInspectLoading: false,
        decisionInspectError: "",
        decisionNotFound: false,
        decisionContributorsLoading: false,
      })
      void this.refreshDecisionSnapshot()
      return
    }
    this.update({
      decisionFilters: filters,
      decisionStatus: "loading",
      decisionError: "",
      decisionContext: undefined,
      decisionOverview: undefined,
      decisionRows: [],
      decisionRowsNextCursor: null,
      decisionRowsLoading: false,
      decisionConfigurations: [],
      decisionConfigurationsNextCursor: null,
      decisionConfigurationsLoading: false,
      decisionInspection: undefined,
      decisionInspectLoading: false,
      decisionInspectError: "",
      decisionNotFound: false,
      decisionContributorsLoading: false,
    })
    void this.refreshDecisionSnapshot()
  }

  async refreshDecisionSnapshot(generation = this.generation) {
    if (this.decisionPromise) {
      this.decisionNeedsRefresh = true
      return this.decisionPromise
    }
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const {
      decisionOverview: readOverview,
      decisionRows: readRows,
      decisionConfigurations: readConfigurations,
    } = transport
    if (!readOverview || !readRows || !readConfigurations) {
      this.update({
        decisionStatus: "missing-rpc",
        decisionError: "The Models decision RPC is not registered in this server session.",
        decisionRowsLoading: false,
        decisionConfigurationsLoading: false,
      })
      return
    }

    const request = ++this.decisionRequest
    const filters = this.data.decisionFilters
    const signal = AbortSignal.any([this.controller.signal, this.decisionController.signal])
    this.update({
      decisionStatus: this.data.decisionOverview ? this.data.decisionStatus : "loading",
      decisionError: "",
      decisionRowsLoading: true,
      decisionConfigurationsLoading: true,
    })
    const current = () =>
      generation === this.generation &&
      request === this.decisionRequest &&
      !signal.aborted &&
      JSON.stringify(filters) === JSON.stringify(this.data.decisionFilters)
    const operation = (async () => {
      try {
        // Refresh and capture sources before taking the global filtered snapshot.
        // connect() and explicit refreshes share the same in-flight source refresh.
        const sourceRefresh =
          this.sourceRefreshPromise ??
          (this.data.sourceRefresh === "idle" ? this.refreshSources(generation) : undefined)
        // A slow source refresh must not hold the comparison back: continue with saved prices.
        if (sourceRefresh) await settleWithin(sourceRefresh, SOURCE_WAIT_MS)
        if (!current()) return

        for (let attempt = 0; attempt < 2; attempt++) {
          const overview = await readOverview(filters, signal)
          if (!current()) return
          const context = overview.context
          if (!decisionContextMatches(context, filters, this.projectDirectory))
            throw new Error("Models decision overview belongs to another project or filter.")

          const [rowResult, configurationResult] = await Promise.allSettled([
            readRows(filters, undefined, context.snapshotID, signal),
            readConfigurations(filters, undefined, context.snapshotID, signal),
          ])
          if (!current()) return

          const fulfilledRows = rowResult.status === "fulfilled" ? rowResult.value : undefined
          const fulfilledConfigurations =
            configurationResult.status === "fulfilled" ? configurationResult.value : undefined
          if (
            (fulfilledRows &&
              !decisionScopeAndFiltersMatch(
                fulfilledRows.context,
                filters,
                this.projectDirectory,
              )) ||
            (fulfilledConfigurations &&
              !decisionScopeAndFiltersMatch(
                fulfilledConfigurations.context,
                filters,
                this.projectDirectory,
              ))
          )
            throw new Error("Models decision reads disagree on project or filters.")

          const failures = [rowResult, configurationResult].filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          )
          if (failures.length) {
            const unrecoverable = failures.find(
              (failure) => !isExpiredDecisionSnapshot(failure.reason),
            )
            if (unrecoverable) throw unrecoverable.reason
            if (attempt === 0) continue
            throw failures[0]!.reason
          }

          if (
            fulfilledRows!.context.snapshotID !== context.snapshotID ||
            fulfilledConfigurations!.context.snapshotID !== context.snapshotID
          ) {
            if (attempt === 0) continue
            throw new Error("Models decision reads disagree on project, filters, or snapshot.")
          }

          const rowPage = fulfilledRows!
          const configurationPage = fulfilledConfigurations!
          const previousSelectedConfigurationID = this.data.selectedConfigurationID
          const decisionRows = rowPage.rows
          const decisionConfigurations = configurationPage.configurations
          const selectedConfigurationID =
            this.data.selectedConfigurationID ??
            decisionConfigurations[0]?.configurationID ??
            decisionRows[0]?.configuration.configurationID ??
            overview.graph.points[0]?.configurationID ??
            null
          const nextStatus = decisionStatus(context, transport.online())
          this.update({
            decisionContext: context,
            decisionOverview: overview,
            decisionRows,
            decisionRowsNextCursor: rowPage.nextCursor,
            decisionRowsLoading: false,
            decisionConfigurations,
            decisionConfigurationsNextCursor: configurationPage.nextCursor,
            decisionConfigurationsLoading: false,
            selectedConfigurationID,
            decisionStatus: nextStatus,
            decisionError:
              nextStatus === "backend-not-ready" ? (context.unavailableReason ?? "") : "",
            decisionInspection: undefined,
            decisionInspectLoading: false,
            decisionInspectError: "",
            decisionNotFound: false,
          })
          if (selectedConfigurationID !== previousSelectedConfigurationID)
            this.selectionChanged({
              selectedTaskID: this.data.selectedTaskID,
              selectedCandidateID: this.data.selectedCandidateID,
              selectedConfigurationID,
            })
          if (selectedConfigurationID) void this.loadDecisionInspection()
          return
        }
        throw new Error("Models decision snapshot could not be captured coherently.")
      } catch (error) {
        if (!current()) return
        const cached = Boolean(this.data.decisionOverview)
        const missingRPC = missingDecisionRPC(error)
        this.update({
          decisionStatus: cached ? "stale" : missingRPC ? "missing-rpc" : "error",
          decisionError: errorMessage(error),
          decisionRowsLoading: false,
          decisionConfigurationsLoading: false,
        })
      }
    })()
    this.decisionPromise = operation
    await operation
    if (generation === this.generation && this.decisionPromise === operation) {
      this.decisionPromise = undefined
      if (this.decisionNeedsRefresh && !this.controller.signal.aborted) {
        this.decisionNeedsRefresh = false
        await this.refreshDecisionSnapshot(generation)
      }
    }
  }

  selectConfiguration(configurationID: string) {
    if (!configurationID || configurationID === this.data.selectedConfigurationID) return
    this.inspectionController.abort()
    this.inspectionController = new AbortController()
    this.decisionInspectionRequest++
    this.decisionContributorsRequest++
    this.decisionContributorsPromise = undefined
    this.update({
      selectedConfigurationID: configurationID,
      decisionInspection: undefined,
      decisionInspectLoading: Boolean(this.data.decisionContext),
      decisionInspectError: "",
      decisionNotFound: false,
      decisionContributorsLoading: false,
    })
    this.selectionChanged({
      selectedTaskID: this.data.selectedTaskID,
      selectedCandidateID: this.data.selectedCandidateID,
      selectedConfigurationID: configurationID,
    })
    void this.loadDecisionInspection()
  }

  async moreDecisionRows() {
    const cursor = this.data.decisionRowsNextCursor
    const context = this.data.decisionContext
    const transport = this.transport
    if (!cursor || !context || !transport?.decisionRows || this.data.decisionRowsLoading) return
    if (this.decisionRowsPromise) return this.decisionRowsPromise
    const generation = this.generation
    const request = ++this.decisionRowsRequest
    const filters = this.data.decisionFilters
    const signal = AbortSignal.any([this.controller.signal, this.decisionController.signal])
    this.update({ decisionRowsLoading: true })
    const operation = (async () => {
      try {
        const page = await transport.decisionRows!(filters, cursor, context.snapshotID, signal)
        if (
          generation !== this.generation ||
          request !== this.decisionRowsRequest ||
          signal.aborted
        )
          return
        if (
          !decisionContextMatches(page.context, filters, this.projectDirectory, context.snapshotID)
        )
          throw new Error("Model row page belongs to another project, filter, or snapshot.")
        const rows = [...this.data.decisionRows]
        const known = new Set(rows.map((row) => row.configuration.configurationID))
        for (const row of page.rows)
          if (!known.has(row.configuration.configurationID)) rows.push(row)
        this.update({
          decisionRows: rows,
          decisionRowsNextCursor: page.nextCursor,
          decisionRowsLoading: false,
        })
      } catch (error) {
        if (
          generation === this.generation &&
          request === this.decisionRowsRequest &&
          !signal.aborted
        )
          this.update({
            decisionRowsLoading: false,
            decisionStatus: this.data.decisionOverview ? "stale" : "error",
            decisionError: errorMessage(error),
          })
      }
    })()
    this.decisionRowsPromise = operation
    await operation
    if (generation === this.generation && this.decisionRowsPromise === operation)
      this.decisionRowsPromise = undefined
  }

  async moreDecisionConfigurations() {
    const cursor = this.data.decisionConfigurationsNextCursor
    const context = this.data.decisionContext
    const transport = this.transport
    if (
      !cursor ||
      !context ||
      !transport?.decisionConfigurations ||
      this.data.decisionConfigurationsLoading
    )
      return
    if (this.decisionConfigurationsPromise) return this.decisionConfigurationsPromise
    const generation = this.generation
    const request = ++this.decisionConfigurationsRequest
    const filters = this.data.decisionFilters
    const signal = AbortSignal.any([this.controller.signal, this.decisionController.signal])
    this.update({ decisionConfigurationsLoading: true })
    const operation = (async () => {
      try {
        const page = await transport.decisionConfigurations!(
          filters,
          cursor,
          context.snapshotID,
          signal,
        )
        if (
          generation !== this.generation ||
          request !== this.decisionConfigurationsRequest ||
          signal.aborted
        )
          return
        if (
          !decisionContextMatches(page.context, filters, this.projectDirectory, context.snapshotID)
        )
          throw new Error(
            "Model configuration page belongs to another project, filter, or snapshot.",
          )
        const configurations = [...this.data.decisionConfigurations]
        const known = new Set(configurations.map((item) => item.configurationID))
        for (const configuration of page.configurations)
          if (!known.has(configuration.configurationID)) configurations.push(configuration)
        this.update({
          decisionConfigurations: configurations,
          decisionConfigurationsNextCursor: page.nextCursor,
          decisionConfigurationsLoading: false,
        })
      } catch (error) {
        if (
          generation === this.generation &&
          request === this.decisionConfigurationsRequest &&
          !signal.aborted
        )
          this.update({
            decisionConfigurationsLoading: false,
            decisionStatus: this.data.decisionOverview ? "stale" : "error",
            decisionError: errorMessage(error),
          })
      }
    })()
    this.decisionConfigurationsPromise = operation
    await operation
    if (generation === this.generation && this.decisionConfigurationsPromise === operation)
      this.decisionConfigurationsPromise = undefined
  }

  private async loadDecisionInspection(contributorCursor?: string) {
    const context = this.data.decisionContext
    const configurationID = this.data.selectedConfigurationID
    const transport = this.transport
    if (
      !context ||
      !configurationID ||
      !transport?.decisionInspect ||
      this.controller.signal.aborted ||
      this.decisionController.signal.aborted
    )
      return
    if (contributorCursor && this.decisionContributorsPromise)
      return this.decisionContributorsPromise

    const generation = this.generation
    const filters = this.data.decisionFilters
    const selectedTaskID = this.data.selectedTaskID
    if (!contributorCursor) {
      this.inspectionController.abort()
      this.inspectionController = new AbortController()
    }
    const request = ++this.decisionInspectionRequest
    const contributorRequest = ++this.decisionContributorsRequest
    const signal = AbortSignal.any([
      this.controller.signal,
      this.decisionController.signal,
      this.inspectionController.signal,
    ])
    const current = () =>
      generation === this.generation &&
      request === this.decisionInspectionRequest &&
      contributorRequest === this.decisionContributorsRequest &&
      !signal.aborted &&
      this.data.selectedConfigurationID === configurationID &&
      this.data.selectedTaskID === selectedTaskID &&
      JSON.stringify(this.data.decisionFilters) === JSON.stringify(filters)
    if (contributorCursor)
      this.update({ decisionContributorsLoading: true, decisionInspectError: "" })
    else
      this.update({
        decisionInspectLoading: true,
        decisionInspectError: "",
        decisionNotFound: false,
      })

    const operation = (async () => {
      try {
        const inspection = await transport.decisionInspect!(
          filters,
          context.snapshotID,
          configurationID,
          selectedTaskID,
          contributorCursor,
          signal,
        )
        if (!current()) return
        if (
          !decisionContextMatches(
            inspection.context,
            filters,
            this.projectDirectory,
            context.snapshotID,
          )
        )
          throw new Error("Model inspection belongs to another project, filter, or snapshot.")
        if (inspection.status === "not-found") {
          if (inspection.configurationID !== configurationID)
            throw new Error("Model inspection returned a different configuration.")
          this.update({
            decisionInspection: undefined,
            decisionNotFound: true,
            decisionInspectLoading: false,
            decisionContributorsLoading: false,
          })
          return
        }
        if (
          inspection.configuration.configurationID !== configurationID ||
          inspection.selectedTaskID !== selectedTaskID
        )
          throw new Error("Model inspection returned a different configuration or selected task.")
        if (contributorCursor) {
          const currentInspection = this.data.decisionInspection
          if (!currentInspection)
            throw new Error("Contributor page has no matching inspection to extend.")
          this.update({
            decisionInspection: {
              ...currentInspection,
              contributorPage: {
                ...inspection.contributorPage,
                contributors: [
                  ...currentInspection.contributorPage.contributors,
                  ...inspection.contributorPage.contributors,
                ],
              },
            },
            decisionContributorsLoading: false,
            decisionInspectError: "",
          })
        } else {
          this.update({
            decisionInspection: inspection,
            decisionInspectLoading: false,
            decisionNotFound: false,
            decisionInspectError: "",
          })
        }
      } catch (error) {
        if (!current()) return
        this.update({
          decisionInspectLoading: false,
          decisionContributorsLoading: false,
          decisionInspectError: errorMessage(error),
        })
      }
    })()
    if (contributorCursor) {
      this.decisionContributorsPromise = operation
      await operation
      if (this.decisionContributorsPromise === operation)
        this.decisionContributorsPromise = undefined
    } else await operation
  }

  async moreDecisionContributors() {
    const cursor = this.data.decisionInspection?.contributorPage.nextCursor
    if (!cursor || this.data.decisionContributorsLoading) return
    await this.loadDecisionInspection(cursor)
  }

  selectCandidate(candidateID: string) {
    if (!this.data.candidates.some((candidate) => candidate.candidateID === candidateID)) return
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
    void this.loadSettings(generation, taskID ?? undefined, selectionRevision)
    if (taskID) void this.loadSelectedTask(generation, taskID, selectionRevision)
    void this.loadDecisionInspection()
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
        else if (selected && !this.data.task && !this.taskController.signal.aborted)
          await this.loadSelectedTask(generation, selected, this.selectionRevision)
        else if (!selected && this.data.selectedTaskID !== null) this.selectTask(null)
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

  async refreshCatalog() {
    return this.loadCatalog(this.generation)
  }

  private async loadCatalog(generation: number) {
    const transport = this.transport
    if (!transport || this.controller.signal.aborted) return
    const request = ++this.catalogRequest
    const signal = this.controller.signal
    this.update({ catalogStatus: "loading", catalogError: "" })
    try {
      const catalog = await transport.catalog(signal)
      if (generation !== this.generation || request !== this.catalogRequest || signal.aborted)
        return
      this.update({ catalog, catalogStatus: "ready", catalogError: "" })
    } catch (error) {
      if (generation === this.generation && request === this.catalogRequest && !signal.aborted)
        this.update({
          catalog: undefined,
          catalogStatus: "unavailable",
          catalogError: errorMessage(error),
        })
    }
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
    this.comparisonRequest++
    this.taskRequest++
    this.selectedTaskLoad = undefined
    this.settingsRequest++
    this.catalogRequest++
    this.selectionRevision++
    this.invalidateAssignmentWrite()
    this.controller.abort()
    this.taskController.abort()
    this.decisionController.abort()
    this.inspectionController.abort()
    this.transport = undefined
    this.projectID = ""
    this.projectDirectory = ""
    this.sourceRefreshPromise = undefined
    this.comparisonPromise = undefined
    this.taskListPromise = undefined
    this.refreshPromise = undefined
    this.comparisonNeedsRefresh = false
    this.decisionPromise = undefined
    this.decisionNeedsRefresh = false
    this.decisionRowsPromise = undefined
    this.decisionConfigurationsPromise = undefined
    this.decisionContributorsPromise = undefined
  }
}
