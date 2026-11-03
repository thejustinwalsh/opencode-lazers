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
import { ModelSettingsOutputSchema } from "./contract.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import { TaskEffortBasisSchema } from "./comparison-presentation.ts"
import type { ModelComparisonTransport } from "./comparison-state.ts"
import { ModelComparisonPanelState } from "./comparison-state.ts"

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

const sources = ["native-catalog", "openrouter-models", "openrouter-benchmarks"] as const

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
  return GetOutput.parse({ status: "found", task, reference: "LZ-1" })
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
