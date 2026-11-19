import { expect, test } from "bun:test"
import { TrajectoryOutput } from "../observability/contract.ts"
import { GetOutput, QueryOutput } from "../tasks/contract.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TaskDetail, TaskPage } from "../tasks/contract.ts"
import type { TrajectoryResponse } from "../observability/contract.ts"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCE_URLS,
  ModelEvidenceOutputSchema,
} from "./source-schema.ts"
import type { ModelEvidenceOutput } from "./source-schema.ts"
import { ModelComparisonOutputSchema } from "./comparison-schema.ts"
import type { ModelComparisonOutput } from "./comparison-schema.ts"
import { ModelCatalogOutputSchema, ModelSettingsOutputSchema } from "./contract.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import { TaskEffortBasisSchema } from "./comparison-presentation.ts"
import {
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionRowsOutputSchema,
} from "./decision-contract.ts"
import type { ModelDecisionContext, ModelDecisionFilters } from "./decision-contract.ts"
import type { ModelComparisonPanelData, ModelComparisonTransport } from "./comparison-state.ts"
import { ModelComparisonPanelState, isSeedable } from "./comparison-state.ts"
import {
  decisionConfigurations,
  decisionContext,
  decisionInspect,
  decisionOverview,
  decisionRead,
  decisionRows,
} from "../../test/models-decision/fixtures/decision.ts"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await tick()
  expect(predicate()).toBe(true)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

const candidate = (modelID: string) => ({
  candidateID: `openai:${modelID}`,
  identity: { providerID: "openai", modelID, variant: null },
  native: {
    name: modelID,
    enabled: true,
    type: "chat",
    contextTokens: null,
    capabilities: { tools: true, input: null, output: null },
    availableVariants: [],
    variantCoverage: { status: "complete", totalVariants: 0, omittedVariants: 0 },
    prices: null,
    ambiguousIdentity: false,
    evidence: { records: [], recordCount: 0, truncated: false },
  },
  correspondence: {
    status: "unresolved",
    basis: null,
    evidence: { records: [], recordCount: 0, truncated: false },
  },
  externalModel: null,
  externalModelEvidence: { records: [], recordCount: 0, truncated: false },
  benchmarkCorrespondence: {
    status: "unresolved",
    basis: null,
    evidence: { records: [], recordCount: 0, truncated: false },
  },
  externalBenchmark: null,
  externalBenchmarkEvidence: { records: [], recordCount: 0, truncated: false },
  effortApplicability: {
    status: "unknown",
    evidence: { records: [], recordCount: 0, truncated: false },
  },
})

const sources = [
  "native-catalog",
  "openrouter-models",
  "openrouter-benchmarks",
  "models-dev",
  "epoch-benchmarks",
] as const
const legacyClassification = {
  revision: 0,
  classification: null,
  provenance: { kind: "legacy" },
} as const

function comparison(
  models: string[],
  options: {
    snapshotIDs?: Partial<Record<(typeof sources)[number], string>>
    nextCursor?: string | null
    totalCandidates?: number
  } = {},
): ModelComparisonOutput {
  const result = ModelComparisonOutputSchema.parse({
    filters: {},
    sources: sources.map((source) => {
      const snapshotID = options.snapshotIDs?.[source] ?? null
      const snapshot = snapshotID
        ? {
            snapshotID,
            projectDirectory: "/repo",
            generation: 1,
            retrievedAt: "2026-11-03T00:00:00.000Z",
            asOf: null,
            version: null,
            citation: null,
            upstreamSourceURL: null,
            sourceURL: MODEL_EVIDENCE_SOURCE_URLS[source],
            query: MODEL_EVIDENCE_QUERIES[source],
            source,
            recordCount: 1,
          }
        : null
      return {
        source,
        storage: "ready",
        snapshotState: snapshotID ? "available" : "none",
        selectedSnapshotID: snapshotID,
        refresh: null,
        snapshot,
      }
    }),
    candidates: models.map(candidate),
    totalCandidates: options.totalCandidates ?? models.length,
    nextCursor: options.nextCursor ?? null,
  })
  return result
}

function tasks(taskIDs: string[], projectDirectory = "/repo"): TaskPage {
  return QueryOutput.parse({
    projectDirectory,
    snapshot: 1,
    count: taskIDs.length,
    tasks: taskIDs.map((taskID, index) => ({
      taskID,
      reference: `LZ-${index + 1}`,
      revision: 1,
      status: "accepted",
      reason: null,
      classification: legacyClassification,
      title: `Task ${index + 1}`,
      objective: `Objective ${index + 1}`,
      createdAt: "2026-11-03T00:00:00.000Z",
      sessionID: "ses-task",
      matches: [],
    })),
    nextCursor: null,
    serverTime: "2026-11-03T00:00:00.000Z",
  })
}

function settings(taskID: string | undefined, revision = 1): ModelSettingsOutput {
  const personas = ["ui", "systems", "small-refactoring"] as const
  return ModelSettingsOutputSchema.parse({
    projectDirectory: "/repo",
    taskID: taskID ?? null,
    personas: personas.map((persona) => {
      const assigned = taskID !== undefined && persona === "ui"
      const target = assigned ? { scope: "task", projectDirectory: "/repo", taskID } : null
      const route = assigned ? { providerID: "openai", id: `route-${revision}` } : null
      const record =
        assigned && target
          ? {
              schemaVersion: 1,
              target,
              persona,
              revision,
              route,
              updatedAt: revision,
            }
          : null
      return {
        persona,
        personaLabel: persona,
        layers: { task: record, project: null, shared: null },
        resolution:
          assigned && target && route
            ? {
                schemaVersion: 1,
                status: "assigned",
                persona,
                personaLabel: persona,
                route,
                provenance: { target, revision },
              }
            : {
                schemaVersion: 1,
                status: "unassigned",
                persona,
                personaLabel: persona,
                route: null,
                provenance: null,
              },
      }
    }),
  })
}

function settingsWithTaskRoute(
  taskID: string,
  revision: number,
  route: { providerID: string; id: string; variant?: string } | null,
): ModelSettingsOutput {
  const output = settings(taskID, revision)
  const target = { scope: "task" as const, projectDirectory: "/repo", taskID }
  return ModelSettingsOutputSchema.parse({
    ...output,
    personas: output.personas.map((persona) =>
      persona.persona !== "ui"
        ? persona
        : {
            ...persona,
            layers: {
              ...persona.layers,
              task: {
                schemaVersion: 1,
                target,
                persona: "ui",
                revision,
                route,
                updatedAt: revision,
              },
            },
            resolution: route
              ? {
                  schemaVersion: 1,
                  status: "assigned",
                  persona: "ui",
                  personaLabel: "ui",
                  route,
                  provenance: { target, revision },
                }
              : {
                  schemaVersion: 1,
                  status: "unassigned",
                  persona: "ui",
                  personaLabel: "ui",
                  route: null,
                  provenance: null,
                },
          },
    ),
  })
}

function catalog() {
  return ModelCatalogOutputSchema.parse({
    source: "Live native OpenCode model catalog",
    observedAt: "2026-11-05T00:00:00Z",
    advisoryOnly: true,
    note: "Catalog choices do not change active dispatch.",
    configuredImplementor: null,
    options: [
      {
        providerID: "openai",
        id: "gpt-6",
        name: "GPT-6",
        enabled: true,
        type: "chat",
        contextTokens: 128_000,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        pricesUSDPerMillionTokens: null,
        variants: ["high", "xhigh"],
      },
    ],
  })
}

const evidence = (): ModelEvidenceOutput =>
  ModelEvidenceOutputSchema.parse({
    sources: sources.map((source) => ({
      source,
      state: "never",
      generation: 0,
      startedAt: null,
      completedAt: null,
      latestSnapshotID: null,
      latestRetrievedAt: null,
      latestRecordCount: null,
      errorCode: null,
      httpStatus: null,
    })),
    snapshot: null,
  })

function detail(
  taskID: string,
  projectID = "project-a",
  objective = `Objective ${taskID}`,
): TaskDetail {
  const task = TaskSpecSchema.parse({
    schemaVersion: 1,
    id: taskID,
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: {
      projectID,
      projectDirectory: "/repo",
      workspaceDirectory: "/repo",
      sessionID: "ses-task",
      startingRevision: { kind: "unborn" },
    },
    proposal: {
      objective,
      exclusions: [],
      constraints: [],
      assumptions: [],
      writeScope: [],
      context: [],
      acceptance: [
        {
          id: "done",
          assertion: "The task result is observable.",
          evidence: [{ kind: "human", decision: "Reviewed" }],
        },
      ],
      requirements: { capabilities: [], skills: [], risk: "low" },
      verification: [],
    },
  })
  return GetOutput.parse({
    status: "found",
    task,
    reference: "LZ-1",
    classification: legacyClassification,
    classificationHistory: [legacyClassification],
  })
}

function effortBasis(inputTokens: number) {
  const category = {
    value: inputTokens,
    unit: "tokens",
    status: "observed",
    valueScope: "task",
  }
  return TaskEffortBasisSchema.parse({
    schemaVersion: 1,
    basis: "test observation",
    attempts: { count: 1, states: [] },
    usage: {
      unit: "tokens",
      categories: {
        uncachedInput: category,
        output: category,
        reasoning: category,
        cacheRead: category,
        cacheWrite: category,
      },
      coverage: {
        totalUniqueSessions: 1,
        nativeCumulativeSnapshots: 0,
        retainedCumulativeSnapshots: 0,
        additiveStepSubtotals: 1,
        missingSessions: [],
        unavailableSessions: [],
        progressTruncated: false,
      },
    },
    routes: {
      assignments: [],
      assessments: [],
      usageAttribution: "observed",
      mixedRoutes: false,
      coverage: {
        totalUniqueSessions: 1,
        observedSessionRouteCount: 0,
        sessionsWithoutCurrentRoute: [],
        observedStepRouteCount: 0,
        stepContextsByStatus: { available: 0, notRead: 0, unavailable: 0 },
        progressTruncated: false,
        truncatedContextSessionIDs: [],
        missingSessionIDs: [],
        unavailableSessionIDs: [],
      },
    },
    cost: {
      fullTaskCostUSD: { valueUSD: null, status: "unknown", meaning: "Not recorded" },
      marketEquivalentCostUSD: { valueUSD: null, status: "unknown", meaning: "Not recorded" },
    },
    quality: { status: "not-recorded", value: null, meaning: "Not recorded" },
  })
}

function trajectory(taskID: string, inputTokens = 10, projectID = "project-a"): TrajectoryResponse {
  return TrajectoryOutput.parse({
    schemaVersion: 1,
    projectID,
    scope: { kind: "project" },
    boundary: {
      repositoryVersion: 1,
      sourceRevision: 1,
      sourceFingerprint: "a".repeat(64),
      nativeRevision: 1,
      eventSequence: 1,
      transitionSequence: 1,
    },
    report: { task: { id: taskID }, effort: { taskEffortBasis: effortBasis(inputTokens) } },
  })
}

function transport(overrides: Partial<ModelComparisonTransport> = {}): ModelComparisonTransport {
  const defaultTaskID = "11111111-1111-4111-8111-111111111111"
  return {
    comparison: async () => comparison(["gpt-6"]),
    refreshSources: async () => evidence(),
    settings: async (taskID) => settings(taskID),
    catalog: async () => catalog(),
    configure: async (update) => ({
      status: "conflict",
      expectedRevision: update.expectedRevision,
      currentRevision: update.expectedRevision,
      current: null,
    }),
    queryTasks: async () => tasks([defaultTaskID]),
    getTask: async () => ({ status: "not_found" }),
    trajectoryStatus: async (taskID) => trajectory(taskID),
    online: () => true,
    ...overrides,
  }
}

const idA = "11111111-1111-4111-8111-111111111111"
const idB = "22222222-2222-4222-8222-222222222222"
const snapshots = (prefix: string) => ({
  "native-catalog": `${prefix[0] ?? "1"}1111111-1111-4111-8111-111111111111`,
  "openrouter-models": `${prefix[0] ?? "1"}2222222-2222-4222-8222-222222222222`,
  "openrouter-benchmarks": `${prefix[0] ?? "1"}3333333-3333-4333-8333-333333333333`,
})

function decisionSnapshotContext(
  projectDirectory: string,
  filters: ModelDecisionFilters,
  snapshotID: string,
): ModelDecisionContext {
  return decisionContext({ scope: { projectDirectory }, filters, snapshotID })
}

function coherentDecisionPage(
  projectDirectory: string,
  filters: ModelDecisionFilters,
  snapshotID: string,
) {
  const context = decisionSnapshotContext(projectDirectory, filters, snapshotID)
  const sourceRows = decisionRows().rows.map((row) =>
    row.efficiency.status === "available" || row.efficiency.status === "single-observation"
      ? {
          ...row,
          cohort: { ...row.cohort, acceptedTaskCount: row.efficiency.observationCount },
        }
      : row,
  )
  const acceptedByConfiguration = new Map(
    sourceRows.map((row) => [row.configuration.configurationID, row.cohort.acceptedTaskCount]),
  )
  const sourceOverview = decisionOverview()
  return {
    overview: ModelDecisionOverviewOutputSchema.parse({
      ...sourceOverview,
      context,
      graph: {
        ...sourceOverview.graph,
        points: sourceOverview.graph.points.map((point) => ({
          ...point,
          acceptedTaskCount:
            acceptedByConfiguration.get(point.configurationID) ?? point.acceptedTaskCount,
        })),
      },
    }),
    rows: ModelDecisionRowsOutputSchema.parse({ ...decisionRows(), context, rows: sourceRows }),
    configurations: ModelDecisionConfigurationsOutputSchema.parse({
      ...decisionConfigurations(),
      context,
    }),
  }
}

const panelErrorMessage = "Observation scope is too large; narrow it"
const rejectPanelRPC = async () => {
  throw { type: "observation_error", data: { message: panelErrorMessage } }
}
const panelErrorCases = [
  { field: "comparisonError", overrides: { comparison: rejectPanelRPC } },
  { field: "sourceRefreshError", overrides: { refreshSources: rejectPanelRPC } },
  { field: "settingsError", overrides: { settings: rejectPanelRPC } },
  { field: "tasksError", overrides: { queryTasks: rejectPanelRPC } },
  { field: "taskError", overrides: { getTask: rejectPanelRPC } },
  { field: "effortError", overrides: { trajectoryStatus: rejectPanelRPC } },
  { field: "catalogError", overrides: { catalog: rejectPanelRPC } },
  { field: "decisionError", overrides: { decisionOverview: rejectPanelRPC } },
  { field: "decisionInspectError", overrides: { decisionInspect: rejectPanelRPC } },
] satisfies Array<{
  field: keyof ModelComparisonPanelData
  overrides: Partial<ModelComparisonTransport>
}>

for (const { field, overrides } of panelErrorCases) {
  test(`F-S14-1 Models ${field} preserves the readable RPC envelope message`, async () => {
    const filters = decisionRead.filters
    const good = coherentDecisionPage("/repo", filters, "snapshot:panel-errors")
    const state = new ModelComparisonPanelState(() => {})
    try {
      state.connect(
        `rpc-error-${field}`,
        "project-a",
        "/repo",
        transport({
          decisionOverview: async () => good.overview,
          decisionRows: async () => good.rows,
          decisionConfigurations: async () => good.configurations,
          ...overrides,
        }),
        { selectedTaskID: null, selectedCandidateID: null },
        filters,
      )
      await until(() => Boolean(state.data[field]))
      // F-S14-1: cover every Models error field, including selected-task failures.
      expect(state.data[field]).not.toContain("[object Object]")
      expect(state.data[field]).toContain(panelErrorMessage)
    } finally {
      state.close()
    }
  })
}

test("decision controller rejects mismatched snapshot, scope, and filters without publishing mixed pages", async () => {
  const filters = decisionRead.filters
  const good = coherentDecisionPage("/repo", filters, "snapshot:coherent")
  for (const mismatch of ["snapshot", "scope", "filters"] as const) {
    const wrongContext = { ...good.rows.context }
    if (mismatch === "snapshot") wrongContext.snapshotID = "snapshot:other"
    if (mismatch === "scope") wrongContext.scope = { projectDirectory: "/other" }
    if (mismatch === "filters") wrongContext.filters = { ...filters, persona: "systems" }
    const wrongRows = ModelDecisionRowsOutputSchema.parse({ ...good.rows, context: wrongContext })
    const state = new ModelComparisonPanelState(() => {})
    state.connect(
      `mismatch-${mismatch}`,
      "project-a",
      "/repo",
      transport({
        queryTasks: async () => tasks([]),
        decisionOverview: async () => good.overview,
        decisionRows: async () => wrongRows,
        decisionConfigurations: async () => good.configurations,
      }),
      { selectedTaskID: null, selectedCandidateID: null },
      filters,
    )
    try {
      await until(() => state.data.decisionStatus === "error" && !state.data.decisionRowsLoading)
      expect(state.data.decisionError).toContain(
        mismatch === "snapshot"
          ? "disagree on project, filters, or snapshot"
          : "disagree on project or filters",
      )
      expect(state.data.decisionOverview).toBeUndefined()
      expect(state.data.decisionRows).toEqual([])
      expect(state.data.decisionConfigurations).toEqual([])
    } finally {
      state.close()
    }
  }
})

test("decision capture does not wait for the open-time source refresh, pins both first pages, and retries an expired or same-scope race once", async () => {
  const filters = decisionRead.filters
  for (const firstAttempt of ["expired", "same-scope-race"] as const) {
    const first = coherentDecisionPage("/repo", filters, `snapshot:${firstAttempt}:first`)
    const second = coherentDecisionPage("/repo", filters, `snapshot:${firstAttempt}:second`)
    const pendingSourceRefresh = deferred<ModelEvidenceOutput>()
    const events: string[] = []
    const rowPins: string[] = []
    const configurationPins: string[] = []
    let overviewReads = 0
    const publishedSnapshots: string[] = []
    const state = new ModelComparisonPanelState((data) => {
      if (data.decisionContext && data.decisionRows.length)
        publishedSnapshots.push(data.decisionContext.snapshotID)
    })
    state.connect(
      `decision-pinned-${firstAttempt}`,
      "project-a",
      "/repo",
      transport({
        queryTasks: async () => tasks([]),
        refreshSources: async () => {
          events.push("sources")
          return pendingSourceRefresh.promise
        },
        decisionOverview: async () => {
          events.push("overview")
          return overviewReads++ === 0 ? first.overview : second.overview
        },
        decisionRows: async (_filters, _cursor, snapshotID) => {
          rowPins.push(snapshotID)
          events.push(`rows:${snapshotID}`)
          if (snapshotID === first.overview.context.snapshotID) {
            if (firstAttempt === "expired")
              throw new Error("Model decision snapshot is unavailable or expired")
            return {
              ...first.rows,
              context: { ...first.rows.context, snapshotID: "snapshot:race:advanced" },
            }
          }
          return second.rows
        },
        decisionConfigurations: async (_filters, _cursor, snapshotID) => {
          configurationPins.push(snapshotID)
          events.push(`configurations:${snapshotID}`)
          return snapshotID === first.overview.context.snapshotID
            ? first.configurations
            : second.configurations
        },
      }),
      { selectedTaskID: null, selectedCandidateID: null },
      filters,
    )
    try {
      // The source refresh is still pending: the snapshot does not sit behind it.
      await until(() => state.data.decisionStatus === "ready" || overviewReads > 0)
      expect(events[0]).toBe("sources")
      pendingSourceRefresh.resolve(evidence())
      await until(
        () =>
          state.data.decisionStatus === "ready" &&
          state.data.decisionContext?.snapshotID === second.overview.context.snapshotID,
      )
      expect(overviewReads).toBe(2)
      expect(rowPins).toEqual([
        first.overview.context.snapshotID,
        second.overview.context.snapshotID,
      ])
      expect(configurationPins).toEqual([
        first.overview.context.snapshotID,
        second.overview.context.snapshotID,
      ])
      expect(publishedSnapshots).toEqual([second.overview.context.snapshotID])
      expect(state.data.decisionRows).toEqual(second.rows.rows)
      expect(state.data.decisionConfigurations).toEqual(second.configurations.configurations)
    } finally {
      state.close()
    }
  }
})

test("repeated expired pinned reads preserve the last complete decision tuple as stale", async () => {
  const filters = decisionRead.filters
  const retained = coherentDecisionPage("/repo", filters, "snapshot:retained")
  let overviewReads = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "decision-pinned-expiry",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async () => {
        overviewReads++
        return overviewReads === 1
          ? retained.overview
          : coherentDecisionPage("/repo", filters, `snapshot:expired:${overviewReads}`).overview
      },
      decisionRows: async (_filters, _cursor, snapshotID) => {
        if (snapshotID === retained.overview.context.snapshotID) return retained.rows
        throw new Error("Model decision snapshot is unavailable or expired")
      },
      decisionConfigurations: async (_filters, _cursor, snapshotID) => {
        if (snapshotID === retained.overview.context.snapshotID) return retained.configurations
        throw new Error("Model decision snapshot is unavailable or expired")
      },
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => state.data.decisionStatus === "ready")
    const retainedOverview = state.data.decisionOverview
    const retainedRows = state.data.decisionRows
    const retainedConfigurations = state.data.decisionConfigurations
    await state.refreshDecisionSnapshot()
    expect(state.data.decisionStatus).toBe("stale")
    expect(state.data.decisionError).toContain("unavailable or expired")
    expect(state.data.decisionOverview).toBe(retainedOverview)
    expect(state.data.decisionRows).toBe(retainedRows)
    expect(state.data.decisionConfigurations).toBe(retainedConfigurations)
    expect(overviewReads).toBe(3)
  } finally {
    state.close()
  }
})

test("late decision overview from old filters cannot replace the current filtered snapshot", async () => {
  const filters = decisionRead.filters
  const nextFilters: ModelDecisionFilters = { ...filters, persona: "systems" }
  const oldPage = coherentDecisionPage("/repo", filters, "snapshot:old-filter")
  const newPage = coherentDecisionPage("/repo", nextFilters, "snapshot:new-filter")
  const pendingOldOverview = deferred<typeof oldPage.overview>()
  let overviewCalls = 0
  let oldSignal: AbortSignal | undefined
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "decision-filter-race",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async (_filters, signal) => {
        overviewCalls++
        if (overviewCalls === 1) {
          oldSignal = signal
          return pendingOldOverview.promise
        }
        return newPage.overview
      },
      decisionRows: async (actualFilters) =>
        actualFilters.persona === "systems" ? newPage.rows : oldPage.rows,
      decisionConfigurations: async (actualFilters) =>
        actualFilters.persona === "systems" ? newPage.configurations : oldPage.configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => overviewCalls === 1 && oldSignal !== undefined)
    state.setDecisionFilters(nextFilters)
    await until(
      () =>
        state.data.decisionStatus === "ready" &&
        state.data.decisionContext?.snapshotID === "snapshot:new-filter",
    )
    expect(oldSignal?.aborted).toBe(true)
    const currentData = state.data
    pendingOldOverview.resolve(oldPage.overview)
    await tick()
    expect(state.data).toBe(currentData)
    expect(state.data.decisionFilters).toEqual(nextFilters)
    expect(state.data.decisionOverview?.context.snapshotID).toBe("snapshot:new-filter")
  } finally {
    state.close()
  }
})

test("a stale inspection completion is ignored after its decision snapshot is refreshed", async () => {
  const filters = decisionRead.filters
  const oldPage = coherentDecisionPage("/repo", filters, "snapshot:before-refresh")
  const newPage = coherentDecisionPage("/repo", filters, "snapshot:after-refresh")
  const pendingOldInspection = deferred<ReturnType<typeof ModelDecisionInspectOutputSchema.parse>>()
  let snapshotReads = 0
  let inspectionCalls = 0
  let oldInspectionSignal: AbortSignal | undefined
  const baseInspection = decisionInspect()
  if (baseInspection.status !== "found") throw new Error("Expected a found inspection fixture")
  const state = new ModelComparisonPanelState(() => {})
  const inspectionFor = (page: typeof oldPage, selectedTaskID: string | null) => {
    const row = page.rows.rows[0]!
    const routeScope =
      page.overview.context.snapshotID === "snapshot:before-refresh" ? "same-route" : "cross-route"
    return ModelDecisionInspectOutputSchema.parse({
      ...baseInspection,
      context: page.overview.context,
      configuration: row.configuration,
      cohort: row.cohort,
      efficiency: row.efficiency,
      nativeReportedCost: row.nativeReportedCost,
      selectedTaskID,
      estimate: {
        ...baseInspection.estimate,
        historyScope: {
          completeness: "complete-accepted-logical-task-retry-history",
          routeScope,
        },
      },
    })
  }
  state.connect(
    "decision-inspection-race",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async () => (++snapshotReads === 1 ? oldPage.overview : newPage.overview),
      decisionRows: async () => (snapshotReads <= 1 ? oldPage.rows : newPage.rows),
      decisionConfigurations: async () =>
        snapshotReads <= 1 ? oldPage.configurations : newPage.configurations,
      decisionInspect: async (
        _filters,
        snapshotID,
        _configurationID,
        selectedTaskID,
        _cursor,
        signal,
      ) => {
        inspectionCalls++
        if (snapshotID === "snapshot:before-refresh") {
          oldInspectionSignal = signal
          return pendingOldInspection.promise
        }
        return inspectionFor(newPage, selectedTaskID)
      },
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => inspectionCalls === 1 && oldInspectionSignal !== undefined)
    await state.refreshDecisionSnapshot()
    await until(
      () =>
        !state.data.decisionInspectLoading &&
        state.data.decisionInspection?.context.snapshotID === "snapshot:after-refresh",
    )
    expect(oldInspectionSignal?.aborted).toBe(true)
    const currentInspection = state.data.decisionInspection
    pendingOldInspection.resolve(inspectionFor(oldPage, null))
    await tick()
    expect(state.data.decisionInspection).toBe(currentInspection)
    expect(state.data.decisionInspection?.context.snapshotID).toBe("snapshot:after-refresh")
    expect(state.data.decisionInspection?.estimate.historyScope?.routeScope).toBe("cross-route")
  } finally {
    state.close()
  }
})

test("contributor paging appends entries without replacing accepted-history metadata", async () => {
  const filters = decisionRead.filters
  const page = coherentDecisionPage("/repo", filters, "snapshot:history-metadata")
  const base = decisionInspect()
  if (base.status !== "found") throw new Error("Expected a found contributor fixture")
  const routeA = { providerID: "provider-a", modelID: "model-a", variant: "100" }
  const routeB = { providerID: "provider-b", modelID: "model-b", variant: "50" }
  const inspection = ModelDecisionInspectOutputSchema.parse({
    ...base,
    context: page.overview.context,
    configuration: page.rows.rows[0]!.configuration,
    selectedTaskID: null,
    estimate: {
      ...base.estimate,
      historyScope: {
        completeness: "complete-accepted-logical-task-retry-history",
        routeScope: "cross-route",
      },
    },
    contributorPage: {
      contributors: [
        {
          ...base.contributorPage.contributors[0]!,
          route: routeA,
          membership: "empirical-history",
        },
      ],
      totalCount: 2,
      nextCursor: "history-contributors-next",
    },
  })
  if (inspection.status !== "found") throw new Error("Expected a found inspection")
  const pagedInspection = ModelDecisionInspectOutputSchema.parse({
    ...inspection,
    estimate: { ...inspection.estimate, historyScope: undefined },
    contributorPage: {
      contributors: [
        {
          ...inspection.contributorPage.contributors[0]!,
          route: routeB,
          membership: "both",
        },
      ],
      totalCount: 2,
      nextCursor: null,
    },
  })
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "history-metadata-paging",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async () => page.overview,
      decisionRows: async () => page.rows,
      decisionConfigurations: async () => page.configurations,
      decisionInspect: async (_filters, _snapshotID, _configurationID, _selectedTaskID, cursor) =>
        cursor ? pagedInspection : inspection,
    }),
    {
      selectedTaskID: null,
      selectedCandidateID: null,
      selectedConfigurationID: inspection.configuration.configurationID,
    },
    filters,
  )
  try {
    await until(
      () =>
        state.data.decisionInspection?.contributorPage.nextCursor === "history-contributors-next",
    )
    await state.moreDecisionContributors()
    const updated = state.data.decisionInspection
    expect(updated?.estimate.historyScope).toEqual({
      completeness: "complete-accepted-logical-task-retry-history",
      routeScope: "cross-route",
    })
    expect(updated?.cohort).toEqual(inspection.cohort)
    expect(updated?.efficiency).toEqual(inspection.efficiency)
    expect(
      updated?.contributorPage.contributors.map((contributor) => [
        contributor.route,
        contributor.membership,
      ]),
    ).toEqual([
      [routeA, "empirical-history"],
      [routeB, "both"],
    ])
  } finally {
    state.close()
  }
})

test("reconnect cancels pending decision reads and ignores their late responses", async () => {
  const filters = decisionRead.filters
  const oldPage = coherentDecisionPage("/repo", filters, "snapshot:old-session")
  const newPage = coherentDecisionPage("/repo", filters, "snapshot:new-session")
  const pendingOldOverview = deferred<typeof oldPage.overview>()
  let oldSignal: AbortSignal | undefined
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "old-session",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async (_filters, signal) => {
        oldSignal = signal
        return pendingOldOverview.promise
      },
      decisionRows: async () => oldPage.rows,
      decisionConfigurations: async () => oldPage.configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => oldSignal !== undefined)
    state.connect(
      "new-session",
      "project-a",
      "/repo",
      transport({
        queryTasks: async () => tasks([]),
        decisionOverview: async () => newPage.overview,
        decisionRows: async () => newPage.rows,
        decisionConfigurations: async () => newPage.configurations,
      }),
      { selectedTaskID: null, selectedCandidateID: null },
      filters,
    )
    await until(
      () =>
        state.data.key === "new-session" &&
        state.data.decisionStatus === "ready" &&
        state.data.decisionContext?.snapshotID === "snapshot:new-session",
    )
    expect(oldSignal?.aborted).toBe(true)
    const newData = state.data
    pendingOldOverview.resolve(oldPage.overview)
    await tick()
    expect(state.data).toBe(newData)
    expect(state.data.key).toBe("new-session")
    expect(state.data.decisionContext?.snapshotID).toBe("snapshot:new-session")
  } finally {
    state.close()
  }
})

test("decision controller keeps missing RPC and backend-not-ready distinct without inventing rows", async () => {
  const filters = decisionRead.filters
  const missingRPC = new ModelComparisonPanelState(() => {})
  missingRPC.connect(
    "missing-decision-rpc",
    "project-a",
    "/repo",
    transport({ queryTasks: async () => tasks([]) }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => missingRPC.data.decisionStatus === "missing-rpc")
    expect(missingRPC.data.decisionOverview).toBeUndefined()
    expect(missingRPC.data.decisionRows).toEqual([])
    expect(missingRPC.data.decisionConfigurations).toEqual([])
    expect(missingRPC.data.selectedConfigurationID).toBeNull()
  } finally {
    missingRPC.close()
  }

  const available = coherentDecisionPage("/repo", filters, "snapshot:backend-not-ready")
  const context = decisionContext({
    scope: { projectDirectory: "/repo" },
    filters,
    snapshotID: "snapshot:backend-not-ready",
    availability: "backend-not-ready",
    unavailableReason: "The producer has not been installed.",
  })
  const overview = ModelDecisionOverviewOutputSchema.parse({
    ...available.overview,
    context,
    graph: { scope: "global-filtered-snapshot", points: [], frontierConfigurationIDs: [] },
    configurationCount: 0,
    groupCount: 0,
  })
  const rows = ModelDecisionRowsOutputSchema.parse({
    ...available.rows,
    context,
    rows: [],
    totalCount: 0,
    nextCursor: null,
  })
  const configurations = ModelDecisionConfigurationsOutputSchema.parse({
    ...available.configurations,
    context,
    configurations: [],
    totalCount: 0,
    nextCursor: null,
  })
  const backendNotReady = new ModelComparisonPanelState(() => {})
  backendNotReady.connect(
    "backend-not-ready",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async () => overview,
      decisionRows: async () => rows,
      decisionConfigurations: async () => configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => backendNotReady.data.decisionStatus === "backend-not-ready")
    expect(backendNotReady.data.decisionError).toBe("The producer has not been installed.")
    expect(backendNotReady.data.decisionOverview?.graph.points).toEqual([])
    expect(backendNotReady.data.decisionRows).toEqual([])
    expect(backendNotReady.data.selectedConfigurationID).toBeNull()
  } finally {
    backendNotReady.close()
  }
})

test("not-found inspection has no estimate and recovers after a later matching inspection", async () => {
  const filters = decisionRead.filters
  const page = coherentDecisionPage("/repo", filters, "snapshot:not-found-recovery")
  let inspectionCalls = 0
  const inspectionFor = (selectedTaskID: string | null) => {
    const row = page.rows.rows[0]!
    return ModelDecisionInspectOutputSchema.parse({
      ...decisionInspect(),
      context: page.overview.context,
      configuration: row.configuration,
      cohort: row.cohort,
      efficiency: row.efficiency,
      nativeReportedCost: row.nativeReportedCost,
      selectedTaskID,
    })
  }
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "not-found-recovery",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async () => page.overview,
      decisionRows: async () => page.rows,
      decisionConfigurations: async () => page.configurations,
      decisionInspect: async (_filters, _snapshotID, configurationID) => {
        inspectionCalls++
        return inspectionCalls === 1
          ? ModelDecisionInspectOutputSchema.parse({
              status: "not-found",
              context: page.overview.context,
              configurationID,
            })
          : inspectionFor(null)
      },
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => state.data.decisionNotFound && !state.data.decisionInspectLoading)
    expect(state.data.decisionInspection).toBeUndefined()
    expect(state.data.decisionNotFound).toBe(true)

    await state.refreshDecisionSnapshot()
    await until(
      () =>
        state.data.decisionInspection?.context.snapshotID === "snapshot:not-found-recovery" &&
        !state.data.decisionInspectLoading,
    )
    expect(inspectionCalls).toBe(2)
    expect(state.data.decisionNotFound).toBe(false)
    expect(state.data.decisionInspection?.estimate.observationCount).toBe(9)
  } finally {
    state.close()
  }
})

test("cached comparison rows publish while the one bounded source refresh is pending", async () => {
  const refresh = deferred<ModelEvidenceOutput>()
  const refreshedComparison = comparison(["gpt-6", "gpt-6-mini"])
  let comparisonCalls = 0
  let refreshCalls = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async () => {
        comparisonCalls++
        return comparisonCalls === 1 ? comparison(["gpt-6"]) : refreshedComparison
      },
      refreshSources: async () => {
        refreshCalls++
        return refresh.promise
      },
      queryTasks: async () => tasks([]),
    }),
    { selectedTaskID: null, selectedCandidateID: null },
  )
  try {
    await until(() => Boolean(state.data.comparison))
    expect(state.data.candidates.map((item) => item.identity.modelID)).toEqual(["gpt-6"])
    expect(state.data.sourceRefresh).toBe("refreshing")
    expect(refreshCalls).toBe(1)

    const duplicate = state.refreshSources()
    expect(refreshCalls).toBe(1)
    refresh.resolve(evidence())
    await duplicate
    await until(() => state.data.candidates.length === 2)
    expect(comparisonCalls).toBe(2)
    expect(state.data.candidates.map((item) => item.identity.modelID)).toEqual([
      "gpt-6",
      "gpt-6-mini",
    ])
    expect(state.data.sourceRefresh).toBe("succeeded")
  } finally {
    state.close()
  }
})

async function latePaginationCannotReplaceNewConnection(outcome: "resolve" | "reject") {
  const oldPage = deferred<ModelComparisonOutput>()
  const oldSourceRefresh = deferred<ModelEvidenceOutput>()
  const newSourceRefresh = deferred<ModelEvidenceOutput>()
  const oldComparison = comparison(["old-cached"], {
    snapshotIDs: snapshots("1111111"),
    nextCursor: "old_cursor",
    totalCandidates: 2,
  })
  const newComparison = comparison(["new-current"], {
    snapshotIDs: snapshots("4444444"),
    nextCursor: "new_cursor",
    totalCandidates: 2,
  })
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async (cursor) => (cursor ? oldPage.promise : oldComparison),
      refreshSources: async () => oldSourceRefresh.promise,
      queryTasks: async () => tasks([], "/repo"),
    }),
    { selectedTaskID: null, selectedCandidateID: null },
  )
  await until(() => Boolean(state.data.comparison?.nextCursor))
  const pendingPagination = state.moreCandidates()

  state.connect(
    "project-b",
    "project-b",
    "/repo",
    transport({
      comparison: async () => newComparison,
      refreshSources: async () => newSourceRefresh.promise,
      queryTasks: async () => tasks([idB]),
      settings: async (taskID) => settings(taskID),
      getTask: async () => ({ status: "not_found" }),
    }),
    { selectedTaskID: null, selectedCandidateID: "openai:off-page-model" },
  )
  try {
    await until(() => Boolean(state.data.comparison) && !state.data.tasksLoading)
    expect(state.data.key).toBe("project-b")
    if (outcome === "resolve")
      oldPage.resolve(
        comparison(["old-page"], {
          snapshotIDs: snapshots("1111111"),
          nextCursor: "old_after",
          totalCandidates: 2,
        }),
      )
    else oldPage.reject(new Error("old page failed"))
    await pendingPagination

    expect(state.data.key).toBe("project-b")
    expect(state.data.projectID).toBe("project-b")
    expect(state.data.comparison).toEqual(newComparison)
    expect(state.data.candidates.map((item) => item.identity.modelID)).toEqual(["new-current"])
    expect(state.data.comparison?.sources.map((source) => source.selectedSnapshotID)).toEqual(
      newComparison.sources.map((source) => source.selectedSnapshotID),
    )
    expect(state.data.comparison?.nextCursor).toBe("new_cursor")
    expect(state.data.comparisonError).toBe("")
    expect(state.data.comparisonStale).toBe(false)
    expect(state.data.comparisonLoading).toBe(false)
    expect(state.data.sourceRefresh).toBe("refreshing")
    expect(state.data.tasks.map((task) => task.taskID)).toEqual([idB])
    expect(state.data.selectedCandidateID).toBe("openai:off-page-model")
  } finally {
    state.close()
  }
}

test("late successful pagination cannot roll back a newer connection", async () => {
  await latePaginationCannotReplaceNewConnection("resolve")
})

test("late pagination failures cannot publish errors into a newer connection", async () => {
  await latePaginationCannotReplaceNewConnection("reject")
})

test("disposing the panel fences a late pagination rollback", async () => {
  const page = deferred<ModelComparisonOutput>()
  const stateChanges: unknown[] = []
  const state = new ModelComparisonPanelState((data) => stateChanges.push(data))
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async (cursor) =>
        cursor
          ? page.promise
          : comparison(["cached"], {
              snapshotIDs: snapshots("1111111"),
              nextCursor: "page_cursor",
              totalCandidates: 2,
            }),
      refreshSources: async () => new Promise<ModelEvidenceOutput>(() => {}),
      queryTasks: async () => tasks([]),
    }),
    { selectedTaskID: null, selectedCandidateID: null },
  )
  await until(() => Boolean(state.data.comparison?.nextCursor))
  const pagination = state.moreCandidates()
  state.close()
  const changesAfterClose = stateChanges.length
  page.resolve(
    comparison(["late"], {
      snapshotIDs: snapshots("7777777"),
      nextCursor: null,
      totalCandidates: 2,
    }),
  )
  await pagination
  expect(stateChanges).toHaveLength(changesAfterClose)
})

test("refresh reloads selected detail, effort and settings without discarding cached values", async () => {
  const refreshTasks = deferred<TaskPage>()
  const refreshDetail = deferred<TaskDetail>()
  const refreshEffort = deferred<TrajectoryResponse>()
  const refreshSettings = deferred<ModelSettingsOutput>()
  const refreshEvidence = deferred<ModelEvidenceOutput>()
  let queryCount = 0
  let detailCount = 0
  let effortCount = 0
  let settingsCount = 0
  let sourceCount = 0
  let comparisonCount = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async () => comparison([`model-${++comparisonCount}`]),
      refreshSources: async () => {
        sourceCount++
        return sourceCount === 1 ? evidence() : refreshEvidence.promise
      },
      queryTasks: async () => {
        queryCount++
        return queryCount === 1 ? tasks([idA, idB]) : refreshTasks.promise
      },
      getTask: async (taskID) => {
        detailCount++
        return detailCount === 1
          ? detail(taskID, "project-a", "Cached detail")
          : refreshDetail.promise
      },
      trajectoryStatus: async (taskID) => {
        effortCount++
        return effortCount === 1 ? trajectory(taskID, 11) : refreshEffort.promise
      },
      settings: async (taskID) => {
        settingsCount++
        return settingsCount === 1 ? settings(taskID, 1) : refreshSettings.promise
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(
      () =>
        state.data.task !== undefined &&
        state.data.effortBasis !== undefined &&
        state.data.settings !== undefined &&
        state.data.sourceRefresh === "succeeded" &&
        !state.data.tasksLoading,
    )
    expect(state.data.task?.status).toBe("found")
    expect(state.data.task?.task.proposal.objective).toBe("Cached detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(11)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-1")

    const firstRefresh = state.refresh()
    await until(() => state.data.taskLoading && state.data.settingsLoading)
    expect(queryCount).toBe(2)
    expect(detailCount).toBe(2)
    expect(effortCount).toBe(2)
    expect(settingsCount).toBe(2)
    expect(sourceCount).toBe(2)
    const duplicateRefresh = state.refresh()
    expect(queryCount).toBe(2)
    expect(detailCount).toBe(2)
    expect(settingsCount).toBe(2)
    expect(state.data.task?.task.proposal.objective).toBe("Cached detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(11)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-1")

    refreshTasks.resolve(tasks([idA, idB]))
    refreshDetail.resolve(detail(idA, "project-a", "Refreshed detail"))
    refreshEffort.resolve(trajectory(idA, 22))
    refreshSettings.resolve(settings(idA, 2))
    refreshEvidence.resolve(evidence())
    await Promise.all([firstRefresh, duplicateRefresh])

    expect(state.data.task?.task.proposal.objective).toBe("Refreshed detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(22)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-2")
    expect(state.data.taskLoading).toBe(false)
    expect(state.data.effortLoading).toBe(false)
    expect(state.data.settingsLoading).toBe(false)
    expect(state.data.taskError).toBe("")
    expect(state.data.effortError).toBe("")
    expect(state.data.settingsError).toBe("")
    expect(state.data.sourceRefresh).toBe("succeeded")
  } finally {
    state.close()
  }
})

test("pending refresh for A cannot reselect A or replace B's detail, effort, or settings", async () => {
  const pendingTasks = deferred<TaskPage>()
  const pendingDetailA = deferred<TaskDetail>()
  const pendingEffortA = deferred<TrajectoryResponse>()
  const pendingSettingsA = deferred<ModelSettingsOutput>()
  const pendingEvidence = deferred<ModelEvidenceOutput>()
  let queryCount = 0
  let detailACount = 0
  let effortACount = 0
  let settingsACount = 0
  let sourceCount = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async () => comparison(["cached"]),
      refreshSources: async () => {
        sourceCount++
        return sourceCount === 1 ? evidence() : pendingEvidence.promise
      },
      queryTasks: async () => {
        queryCount++
        return queryCount === 1 ? tasks([idA, idB]) : pendingTasks.promise
      },
      getTask: async (taskID) => {
        if (taskID === idB) return detail(idB, "project-a", "B detail")
        detailACount++
        return detailACount === 1 ? detail(idA, "project-a", "A cached") : pendingDetailA.promise
      },
      trajectoryStatus: async (taskID) => {
        if (taskID === idB) return trajectory(idB, 222)
        effortACount++
        return effortACount === 1 ? trajectory(idA, 111) : pendingEffortA.promise
      },
      settings: async (taskID) => {
        if (taskID === idB) return settings(idB, 20)
        settingsACount++
        return settingsACount === 1 ? settings(idA, 10) : pendingSettingsA.promise
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(() => state.data.task !== undefined && state.data.settings !== undefined)
    const refresh = state.refresh()
    await until(() => detailACount === 2 && effortACount === 2 && settingsACount === 2)

    state.selectTask(idB)
    await until(
      () =>
        state.data.selectedTaskID === idB &&
        state.data.task?.status === "found" &&
        !state.data.effortLoading &&
        !state.data.settingsLoading,
    )
    expect(state.data.task?.task.proposal.objective).toBe("B detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(222)
    expect(state.data.settings?.taskID).toBe(idB)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-20")

    pendingTasks.resolve(tasks([idA, idB]))
    pendingDetailA.resolve(detail(idA, "project-a", "Stale A detail"))
    pendingEffortA.resolve(trajectory(idA, 999))
    pendingSettingsA.resolve(settings(idA, 99))
    pendingEvidence.resolve(evidence())
    await refresh

    expect(state.data.selectedTaskID).toBe(idB)
    expect(state.data.task?.task.proposal.objective).toBe("B detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(222)
    expect(state.data.settings?.taskID).toBe(idB)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-20")
    expect(state.data.taskError).toBe("")
    expect(state.data.effortError).toBe("")
    expect(state.data.settingsError).toBe("")
  } finally {
    state.close()
  }
})

async function pendingBSelectionSurvivesTaskListRefresh(firstSettled: "detail" | "effort") {
  const pendingTasks = deferred<TaskPage>()
  const refreshDetailA = deferred<TaskDetail>()
  const refreshEffortA = deferred<TrajectoryResponse>()
  const pendingDetailB = deferred<TaskDetail>()
  const pendingEffortB = deferred<TrajectoryResponse>()
  let detailBSettled = false
  let effortBSettled = false
  const detailBResult = pendingDetailB.promise.then((result) => {
    detailBSettled = true
    return result
  })
  const effortBResult = pendingEffortB.promise.then((result) => {
    effortBSettled = true
    return result
  })
  let queryCount = 0
  let detailACount = 0
  let effortACount = 0
  let detailBCount = 0
  let effortBCount = 0
  const bSignals: AbortSignal[] = []
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async () => comparison(["cached"]),
      queryTasks: async () => {
        queryCount++
        return queryCount === 1 ? tasks([idA, idB]) : pendingTasks.promise
      },
      getTask: async (taskID, signal) => {
        if (taskID === idA) {
          detailACount++
          return detailACount === 1 ? detail(idA, "project-a", "A cached") : refreshDetailA.promise
        }
        detailBCount++
        bSignals.push(signal)
        if (detailBCount === 1) return detailBResult
        throw new Error("replacement B detail failed")
      },
      trajectoryStatus: async (taskID, signal) => {
        if (taskID === idA) {
          effortACount++
          return effortACount === 1 ? trajectory(idA, 111) : refreshEffortA.promise
        }
        effortBCount++
        bSignals.push(signal)
        if (effortBCount === 1) return effortBResult
        throw new Error("replacement B effort failed")
      },
      settings: async (taskID) => settings(taskID),
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )

  try {
    await until(
      () =>
        state.data.task !== undefined &&
        state.data.effortBasis !== undefined &&
        !state.data.tasksLoading,
    )
    const refresh = state.refresh()
    await until(() => detailACount === 2 && effortACount === 2)

    state.selectTask(idB)
    await until(() => detailBCount === 1 && effortBCount === 1)
    expect(bSignals).toHaveLength(2)
    expect(bSignals[0]).toBe(bSignals[1])

    if (firstSettled === "detail") {
      pendingDetailB.resolve(detail(idB, "project-a", "B detail"))
      await until(() => detailBSettled)
    } else {
      pendingEffortB.resolve(trajectory(idB, 222))
      await until(() => effortBSettled)
    }

    pendingTasks.resolve(tasks([idA, idB]))
    await until(() => !state.data.tasksLoading)
    expect(detailBCount).toBe(1)
    expect(effortBCount).toBe(1)
    expect(bSignals[0]?.aborted).toBe(false)
    expect(bSignals[1]?.aborted).toBe(false)

    if (firstSettled === "detail") pendingEffortB.resolve(trajectory(idB, 222))
    else pendingDetailB.resolve(detail(idB, "project-a", "B detail"))
    await until(
      () =>
        state.data.task?.task.proposal.objective === "B detail" &&
        state.data.effortBasis?.usage.categories.uncachedInput.value === 222 &&
        !state.data.taskLoading &&
        !state.data.effortLoading,
    )

    expect(state.data.taskError).toBe("")
    expect(state.data.effortError).toBe("")
    expect(state.data.selectedTaskID).toBe(idB)
    expect(bSignals[0]?.aborted).toBe(false)
    expect(bSignals[1]?.aborted).toBe(false)

    refreshDetailA.resolve(detail(idA, "project-a", "Stale A detail"))
    refreshEffortA.resolve(trajectory(idA, 999))
    await refresh
    expect(state.data.task?.task.proposal.objective).toBe("B detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(222)
  } finally {
    state.close()
  }
}

test("pending B detail survives completion of A's refreshed task list", async () => {
  await pendingBSelectionSurvivesTaskListRefresh("detail")
})

test("pending B effort survives completion of A's refreshed task list", async () => {
  await pendingBSelectionSurvivesTaskListRefresh("effort")
})

test("reconnecting does not reuse or publish obsolete selected-task reads", async () => {
  const oldDetail = deferred<TaskDetail>()
  const oldEffort = deferred<TrajectoryResponse>()
  let oldDetailCount = 0
  let oldEffortCount = 0
  const oldSignals: AbortSignal[] = []
  const newSignals: AbortSignal[] = []
  const changes: unknown[] = []
  const state = new ModelComparisonPanelState((data) => changes.push(data))
  state.connect(
    "session-a",
    "project-a",
    "/repo",
    transport({
      comparison: async () => comparison(["old"]),
      queryTasks: async () => tasks([idA]),
      getTask: async (_taskID, signal) => {
        oldDetailCount++
        oldSignals.push(signal)
        return oldDetail.promise
      },
      trajectoryStatus: async (_taskID, signal) => {
        oldEffortCount++
        oldSignals.push(signal)
        return oldEffort.promise
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  await until(() => oldDetailCount === 1 && oldEffortCount === 1)

  state.connect(
    "session-b",
    "project-a",
    "/repo",
    transport({
      comparison: async () => comparison(["new"]),
      queryTasks: async () => tasks([idA]),
      getTask: async (_taskID, signal) => {
        newSignals.push(signal)
        return detail(idA, "project-a", "New session detail")
      },
      trajectoryStatus: async (_taskID, signal) => {
        newSignals.push(signal)
        return trajectory(idA, 222)
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )

  try {
    await until(
      () =>
        state.data.key === "session-b" &&
        state.data.task?.task.proposal.objective === "New session detail" &&
        state.data.effortBasis?.usage.categories.uncachedInput.value === 222 &&
        !state.data.tasksLoading &&
        !state.data.taskLoading &&
        !state.data.effortLoading &&
        !state.data.settingsLoading,
    )
    expect(oldSignals).toHaveLength(2)
    expect(oldSignals[0]?.aborted).toBe(true)
    expect(oldSignals[1]?.aborted).toBe(true)
    expect(newSignals).toHaveLength(2)
    expect(newSignals[0]).toBe(newSignals[1])
    expect(newSignals[0]?.aborted).toBe(false)

    await tick()
    const changesAfterNewResult = changes.length
    oldDetail.resolve(detail(idA, "project-a", "Stale session detail"))
    oldEffort.resolve(trajectory(idA, 999))
    await tick()

    expect(changes).toHaveLength(changesAfterNewResult)
    expect(state.data.key).toBe("session-b")
    expect(state.data.task?.task.proposal.objective).toBe("New session detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(222)
  } finally {
    state.close()
  }
})

test("failed refreshes retain cached values and report each unavailable read", async () => {
  let queryCount = 0
  let detailCount = 0
  let effortCount = 0
  let settingsCount = 0
  let sourceCount = 0
  let retryFailures = false
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      comparison: async () => comparison(["cached-model"]),
      refreshSources: async () => {
        sourceCount++
        if (sourceCount === 2 && !retryFailures) throw new Error("source refresh failed")
        return evidence()
      },
      queryTasks: async () => {
        queryCount++
        if (queryCount === 2 && !retryFailures) throw new Error("task list failed")
        return tasks([idA])
      },
      getTask: async (taskID) => {
        detailCount++
        if (detailCount === 2 && !retryFailures) throw new Error("task detail failed")
        return detail(
          taskID,
          "project-a",
          detailCount === 1 ? "Cached task detail" : "Recovered task detail",
        )
      },
      trajectoryStatus: async (taskID) => {
        effortCount++
        if (effortCount === 2 && !retryFailures) throw new Error("task effort failed")
        return trajectory(taskID, effortCount === 1 ? 55 : 77)
      },
      settings: async (taskID) => {
        settingsCount++
        if (settingsCount === 2 && !retryFailures) throw new Error("settings failed")
        return settings(taskID, settingsCount === 1 ? 5 : 6)
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(
      () =>
        state.data.task !== undefined &&
        state.data.effortBasis !== undefined &&
        state.data.settings !== undefined &&
        state.data.sourceRefresh === "succeeded" &&
        !state.data.tasksLoading,
    )
    await state.refresh()

    expect(state.data.task?.task.proposal.objective).toBe("Cached task detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(55)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-5")
    expect(state.data.tasks.map((task) => task.taskID)).toEqual([idA])
    expect(state.data.tasksError).toBe("task list failed")
    expect(state.data.taskError).toBe("task detail failed")
    expect(state.data.effortError).toBe("task effort failed")
    expect(state.data.settingsError).toBe("settings failed")
    expect(state.data.sourceRefresh).toBe("failed")
    expect(state.data.sourceRefreshError).toBe("source refresh failed")
    expect(state.data.taskLoading).toBe(false)
    expect(state.data.effortLoading).toBe(false)
    expect(state.data.tasksLoading).toBe(false)
    expect(state.data.settingsLoading).toBe(false)
    expect(state.data.stale).toBe(true)

    retryFailures = true
    await state.refresh()
    expect(state.data.task?.task.proposal.objective).toBe("Recovered task detail")
    expect(state.data.effortBasis?.usage.categories.uncachedInput.value).toBe(77)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-6")
    expect(state.data.tasksError).toBe("")
    expect(state.data.taskError).toBe("")
    expect(state.data.effortError).toBe("")
    expect(state.data.settingsError).toBe("")
    expect(state.data.sourceRefresh).toBe("succeeded")
  } finally {
    state.close()
  }
})

test("selected task effort stays unknown when a valid response omits categorized data", async () => {
  let queryCount = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => (queryCount++ === 0 ? tasks([idA, idB]) : tasks([])),
      getTask: async () => ({ status: "not_found" }),
      trajectoryStatus: async (taskID) =>
        TrajectoryOutput.parse({
          schemaVersion: 1,
          projectID: "project-a",
          scope: { kind: "project" },
          boundary: {
            repositoryVersion: 1,
            sourceRevision: 1,
            sourceFingerprint: "a".repeat(64),
            nativeRevision: 1,
            eventSequence: 1,
            transitionSequence: 1,
          },
          report: { task: { id: taskID }, effort: { taskEffortBasis: null } },
        }),
    }),
    { selectedTaskID: null, selectedCandidateID: null },
  )
  try {
    await until(() => !state.data.tasksLoading && state.data.selectedTaskID === idA)
    state.selectTask(idB)
    await until(() => !state.data.effortLoading)
    expect(state.data.selectedTaskID).toBe(idB)
    expect(state.data.effortBasis).toBeUndefined()
    expect(state.data.effortError).toContain("Categorized task effort is unavailable")
  } finally {
    state.close()
  }
})

test("native catalog loading and failure do not block exact manual mapping writes", async () => {
  const pendingCatalog = deferred<ReturnType<typeof catalog>>()
  const requestedRoute = { providerID: "manual-provider", id: "manual-model" }
  let revision = 1
  let latest = settingsWithTaskRoute(idA, revision, { providerID: "openai", id: "route-1" })
  let catalogRequests = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      catalog: async () => {
        catalogRequests++
        if (catalogRequests === 1) return pendingCatalog.promise
        throw new Error("native catalog offline")
      },
      settings: async () => latest,
      configure: async (update) => {
        revision++
        latest = settingsWithTaskRoute(idA, revision, update.route)
        return {
          status: "updated",
          mapping: {
            schemaVersion: 1,
            target: { scope: "task", projectDirectory: "/repo", taskID: idA },
            persona: update.persona,
            revision,
            route: update.route,
            updatedAt: revision,
          },
        }
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(() => state.data.settings !== undefined)
    expect(state.data.catalogStatus).toBe("loading")

    await state.configureMapping("ui", "task", requestedRoute)
    expect(state.data.assignmentWrite).toMatchObject({ status: "confirmed", route: requestedRoute })

    pendingCatalog.reject(new Error("native catalog request timed out"))
    await until(() => state.data.catalogStatus === "unavailable")
    expect(state.data.catalogError).toContain("native catalog request timed out")
    await state.refreshCatalog()
    expect(catalogRequests).toBe(2)
    expect(state.data.catalogStatus).toBe("unavailable")

    const laterManualRoute = {
      providerID: "provider-not-in-catalog",
      id: "custom/model",
      variant: "native/xhigh",
    }
    await state.configureMapping("ui", "task", laterManualRoute)
    expect(state.data.assignmentWrite).toMatchObject({
      status: "confirmed",
      route: laterManualRoute,
    })
    expect(state.data.settings?.personas[0]?.layers.task?.route).toEqual(laterManualRoute)
  } finally {
    state.close()
  }
})

test("mapping writes use exact routes and are saved only after matching settings readback", async () => {
  const route = {
    providerID: "provider-not-in-catalog",
    id: "manual/model-id",
    variant: "native/xhigh",
  }
  let latest = settingsWithTaskRoute(idA, 1, { providerID: "openai", id: "route-1" })
  const writes: unknown[] = []
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      settings: async () => latest,
      configure: async (update) => {
        writes.push(update)
        latest = settingsWithTaskRoute(idA, 2, update.route)
        return {
          status: "updated",
          mapping: {
            schemaVersion: 1,
            target: { scope: "task", projectDirectory: "/repo", taskID: idA },
            persona: "ui",
            revision: 2,
            route: update.route,
            updatedAt: 2,
          },
        }
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(() => state.data.settings !== undefined)
    await state.configureMapping("ui", "task", route)

    expect(writes).toEqual([
      {
        target: { scope: "task", taskID: idA },
        persona: "ui",
        expectedRevision: 1,
        route,
      },
    ])
    expect(state.data.settings?.personas[0]?.layers.task).toMatchObject({
      revision: 2,
      route,
    })
    expect(state.data.settings?.personas[0]?.resolution).toMatchObject({
      status: "assigned",
      route,
      provenance: { target: { scope: "task", taskID: idA }, revision: 2 },
    })
    expect(state.data.assignmentWrite).toMatchObject({
      status: "confirmed",
      revision: 2,
      route,
    })
  } finally {
    state.close()
  }
})

test("uncertain writes stay unconfirmed until an exact authoritative readback arrives", async () => {
  const route = {
    providerID: "manual-provider",
    id: "manual-model",
    variant: "native/effort",
  }
  let latest = settingsWithTaskRoute(idA, 1, { providerID: "openai", id: "route-1" })
  let settingsReads = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      settings: async () => {
        settingsReads++
        return latest
      },
      configure: async () => {
        throw new Error("connection closed after send")
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(() => state.data.settings !== undefined)
    await state.configureMapping("ui", "task", route)

    expect(settingsReads).toBe(2)
    expect(state.data.assignmentWrite).toMatchObject({
      status: "uncertain",
      route,
      revision: 2,
    })
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-1")

    latest = settingsWithTaskRoute(idA, 2, route)
    await state.recheckAssignmentWrite()

    expect(state.data.assignmentWrite).toMatchObject({ status: "confirmed", revision: 2, route })
    expect(state.data.settings?.personas[0]?.layers.task?.route).toEqual(route)
    expect(settingsReads).toBe(3)
  } finally {
    state.close()
  }
})

test("stale mapping revisions show the newer authoritative route without retrying", async () => {
  const currentRoute = { providerID: "other-editor", id: "route-2" }
  let configureCount = 0
  let latest = settingsWithTaskRoute(idA, 1, { providerID: "openai", id: "route-1" })
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      settings: async () => latest,
      configure: async (update) => {
        configureCount++
        latest = settingsWithTaskRoute(idA, 2, currentRoute)
        return {
          status: "conflict",
          expectedRevision: update.expectedRevision,
          currentRevision: 2,
          current: {
            schemaVersion: 1,
            target: { scope: "task", projectDirectory: "/repo", taskID: idA },
            persona: "ui",
            revision: 2,
            route: currentRoute,
            updatedAt: 2,
          },
        }
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(() => state.data.settings !== undefined)
    await state.configureMapping("ui", "task", {
      providerID: "stale-editor",
      id: "never-current",
    })

    expect(configureCount).toBe(1)
    expect(state.data.assignmentWrite).toMatchObject({ status: "conflict", revision: 2 })
    expect(state.data.settings?.personas[0]?.layers.task?.route).toEqual(currentRoute)
  } finally {
    state.close()
  }
})

test("late mapping responses cannot replace a newly selected task", async () => {
  const pending = deferred<Awaited<ReturnType<ModelComparisonTransport["configure"]>>>()
  let configureSignal: AbortSignal | undefined
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([idA, idB]),
      settings: async (taskID) =>
        settingsWithTaskRoute(taskID ?? idA, taskID === idB ? 20 : 1, {
          providerID: "openai",
          id: taskID === idB ? "route-20" : "route-1",
        }),
      configure: async (_update, signal) => {
        configureSignal = signal
        return pending.promise
      },
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    await until(() => state.data.settings?.taskID === idA)
    const save = state.configureMapping("ui", "task", {
      providerID: "provider-a",
      id: "route-a-new",
    })
    await until(() => state.data.assignmentWrite?.status === "saving")

    state.selectTask(idB)
    await until(() => state.data.settings?.taskID === idB)
    expect(configureSignal?.aborted).toBe(true)

    pending.resolve({
      status: "updated",
      mapping: {
        schemaVersion: 1,
        target: { scope: "task", projectDirectory: "/repo", taskID: idA },
        persona: "ui",
        revision: 2,
        route: { providerID: "provider-a", id: "route-a-new" },
        updatedAt: 2,
      },
    })
    await save

    expect(state.data.selectedTaskID).toBe(idB)
    expect(state.data.settings?.taskID).toBe(idB)
    expect(state.data.settings?.personas[0]?.layers.task?.route?.id).toBe("route-20")
    expect(state.data.assignmentWrite).toBeUndefined()
  } finally {
    state.close()
  }
})

test("a seeded connection shows the last snapshot at once and refreshes it in place", async () => {
  const filters = decisionRead.filters
  const good = coherentDecisionPage("/repo", filters, "snapshot:coherent")
  const first = new ModelComparisonPanelState(() => {})
  first.connect(
    "remount-key",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async () => good.overview,
      decisionRows: async () => good.rows,
      decisionConfigurations: async () => good.configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  await until(() => first.data.decisionStatus === "ready" && !first.data.decisionRowsLoading)
  const remembered = first.data
  first.close()
  expect(isSeedable(remembered)).toBe(true)

  // The refresh never returns in this test: whatever shows is what was kept.
  const never = () => new Promise<never>(() => {})
  const second = new ModelComparisonPanelState(() => {})
  second.connect(
    "remount-key",
    "project-a",
    "/repo",
    transport({
      queryTasks: never,
      comparison: never,
      refreshSources: never,
      decisionOverview: never,
      decisionRows: never,
      decisionConfigurations: never,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
    remembered,
  )
  try {
    expect(second.data.decisionOverview).toBe(remembered.decisionOverview)
    expect(second.data.decisionStatus).toBe("ready")
    expect(second.data.decisionRows).toBe(remembered.decisionRows)
    expect(second.data.candidates).toBe(remembered.candidates)
    // Loading flags describe the refresh; none of them blanks the content.
    expect(second.data.comparisonLoading).toBe(true)
    expect(second.data.decisionError).toBe("")
  } finally {
    second.close()
  }

  // A snapshot with nothing to show is never restored: that connection starts from the skeleton.
  const blankSeed = new ModelComparisonPanelState(() => {}).data
  expect(isSeedable(blankSeed)).toBe(false)
  const third = new ModelComparisonPanelState(() => {})
  third.connect(
    "remount-key",
    "project-a",
    "/repo",
    transport({
      queryTasks: never,
      comparison: never,
      refreshSources: never,
      decisionOverview: never,
      decisionRows: never,
      decisionConfigurations: never,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
    blankSeed,
  )
  try {
    expect(third.data.decisionOverview).toBeUndefined()
    expect(third.data.decisionStatus).toBe("loading")
  } finally {
    third.close()
  }
})

test("switching to filters seen before shows that result at once", async () => {
  const filters = decisionRead.filters
  const other: ModelDecisionFilters = { ...filters, persona: "systems" }
  const page = (value: ModelDecisionFilters) => coherentDecisionPage("/repo", value, "snapshot:a")
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "filters-key",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      decisionOverview: async (requested) => page(requested).overview,
      decisionRows: async (requested) => page(requested).rows,
      decisionConfigurations: async (requested) => page(requested).configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => state.data.decisionStatus === "ready" && !state.data.decisionRowsLoading)
    const remembered: ModelComparisonPanelData = {
      ...state.data,
      decisionFilters: other,
      decisionOverview: ModelDecisionOverviewOutputSchema.parse(page(other).overview),
    }
    state.setDecisionFilters(other, remembered)
    // Not the skeleton: the previous result for these filters is there before any read returns.
    expect(state.data.decisionFilters.persona).toBe("systems")
    expect(state.data.decisionOverview).toBe(remembered.decisionOverview)
    expect(state.data.decisionStatus).toBe("ready")
  } finally {
    state.close()
  }
})

test("the decision snapshot reaches the chart while the open-time source refresh never answers", async () => {
  const filters = decisionRead.filters
  const page = coherentDecisionPage("/repo", filters, "snapshot:no-wait")
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "no-source-wait",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      refreshSources: () => new Promise<ModelEvidenceOutput>(() => {}),
      decisionOverview: async () => page.overview,
      decisionRows: async () => page.rows,
      decisionConfigurations: async () => page.configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => state.data.decisionStatus === "ready" && !state.data.decisionRowsLoading)
    expect(state.data.sourceRefresh).toBe("refreshing")
    expect(state.data.decisionOverview).toBeDefined()
  } finally {
    state.close()
  }
})

test("a refresh the person asked for is still waited on before the snapshot is read", async () => {
  const filters = decisionRead.filters
  const page = coherentDecisionPage("/repo", filters, "snapshot:forced")
  const forced = deferred<ModelEvidenceOutput>()
  const events: string[] = []
  let sourceReads = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "forced-source-wait",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => tasks([]),
      refreshSources: async (_signal, force) => {
        sourceReads++
        if (!force) return evidence()
        events.push("forced-sources")
        return forced.promise
      },
      decisionOverview: async () => {
        events.push("overview")
        return page.overview
      },
      decisionRows: async () => page.rows,
      decisionConfigurations: async () => page.configurations,
    }),
    { selectedTaskID: null, selectedCandidateID: null },
    filters,
  )
  try {
    await until(() => state.data.decisionStatus === "ready")
    events.length = 0
    const refreshing = state.refresh()
    await until(() => events.includes("forced-sources"))
    await tick()
    expect(events).toEqual(["forced-sources"])
    forced.resolve(evidence())
    await refreshing
    expect(events).toEqual(["forced-sources", "overview"])
    expect(sourceReads).toBeGreaterThan(1)
  } finally {
    state.close()
  }
})
