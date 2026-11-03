import { expect, test } from "bun:test"
import type { TaskDetail, TaskPage } from "../tasks/contract.ts"
import type { ModelComparisonOutput } from "./comparison-schema.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import type { ModelEvidenceOutput } from "./source-schema.ts"
import type { TrajectoryResponse } from "../observability/contract.ts"
import type { ModelComparisonTransport } from "./comparison-state.ts"
import { ModelComparisonPanelState } from "./comparison-state.ts"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
    prices: null,
    ambiguousIdentity: false,
    evidence: { records: [], recordCount: 1, truncated: false },
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

const comparison = (models: string[]): ModelComparisonOutput =>
  ({
    filters: {},
    sources: ["native-catalog", "openrouter-models", "openrouter-benchmarks"].map((source) => ({
      source,
      storage: "ready",
      snapshotState: "none",
      selectedSnapshotID: null,
      refresh: null,
      snapshot: null,
    })),
    candidates: models.map(candidate),
    totalCandidates: models.length,
    nextCursor: null,
  }) as ModelComparisonOutput

const tasks = (taskIDs: string[], projectDirectory = "/repo"): TaskPage =>
  ({
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
  }) as TaskPage

const settings = (taskID: string | undefined): ModelSettingsOutput =>
  ({
    projectDirectory: "/repo",
    taskID: taskID ?? null,
    personas: [],
  }) as unknown as ModelSettingsOutput

const evidence = {} as ModelEvidenceOutput

function transport(overrides: Partial<ModelComparisonTransport> = {}): ModelComparisonTransport {
  return {
    comparison: async () => comparison(["gpt-6"]),
    refreshSources: async () => evidence,
    settings: async (taskID) => settings(taskID),
    queryTasks: async () => tasks(["11111111-1111-4111-8111-111111111111"]),
    getTask: async (): Promise<TaskDetail> => ({ status: "not_found" }),
    trajectoryStatus: async (taskID): Promise<TrajectoryResponse> =>
      ({
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
        report: { task: { id: taskID }, effort: {} },
      }) as TrajectoryResponse,
    online: () => true,
    ...overrides,
  }
}

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
    for (let index = 0; index < 20 && !state.data.comparison; index++) await tick()
    expect(state.data.candidates.map((item) => item.identity.modelID)).toEqual(["gpt-6"])
    expect(state.data.sourceRefresh).toBe("refreshing")
    expect(refreshCalls).toBe(1)

    const duplicate = state.refreshSources()
    expect(refreshCalls).toBe(1)
    refresh.resolve(evidence)
    await duplicate
    for (let index = 0; index < 20 && state.data.candidates.length < 2; index++) await tick()
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

test("late comparison and task responses cannot publish after switching project", async () => {
  const oldComparison = deferred<ModelComparisonOutput>()
  const oldTasks = deferred<TaskPage>()
  const state = new ModelComparisonPanelState(() => {})
  const idA = "11111111-1111-4111-8111-111111111111"
  const idB = "22222222-2222-4222-8222-222222222222"
  state.connect(
    "project-a",
    "project-a",
    "/repo-a",
    transport({
      comparison: () => oldComparison.promise,
      refreshSources: async () => evidence,
      queryTasks: () => oldTasks.promise,
    }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  state.connect(
    "project-b",
    "project-b",
    "/repo",
    transport({
      comparison: async () => comparison(["project-b-model"]),
      queryTasks: async () => tasks([idB]),
      getTask: async (): Promise<TaskDetail> => ({ status: "not_found" }),
    }),
    { selectedTaskID: null, selectedCandidateID: null },
  )
  try {
    for (let index = 0; index < 30 && !state.data.comparison; index++) await tick()
    oldComparison.resolve(comparison(["project-a-model"]))
    oldTasks.resolve(tasks([idA], "/repo-a"))
    await tick()
    expect(state.data.key).toBe("project-b")
    expect(state.data.projectID).toBe("project-b")
    expect(state.data.candidates.map((item) => item.identity.modelID)).toEqual(["project-b-model"])
    expect(state.data.tasks.map((item) => item.taskID)).toEqual([idB])
  } finally {
    state.close()
  }
})

test("selected task status is requested by exact task ID and missing categorized data stays unknown", async () => {
  const taskID = "11111111-1111-4111-8111-111111111111"
  const firstTaskID = "22222222-2222-4222-8222-222222222222"
  const requested: string[] = []
  const detailRequested: string[] = []
  let taskQueryCount = 0
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({
      queryTasks: async () => (taskQueryCount++ === 0 ? tasks([firstTaskID, taskID]) : tasks([])),
      getTask: async (requestedTask): Promise<TaskDetail> => {
        detailRequested.push(requestedTask)
        return { status: "not_found" }
      },
      trajectoryStatus: async (requestedTask): Promise<TrajectoryResponse> => {
        requested.push(requestedTask)
        return {
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
          report: { task: { id: requestedTask }, effort: { taskEffortBasis: undefined } },
        } as TrajectoryResponse
      },
    }),
    { selectedTaskID: null, selectedCandidateID: null },
  )
  try {
    for (let index = 0; index < 30 && state.data.tasksLoading; index++) await tick()
    expect(state.data.selectedTaskID).toBe(firstTaskID)
    state.selectTask(taskID)
    for (
      let index = 0;
      index < 30 && (!requested.includes(taskID) || state.data.effortLoading);
      index++
    )
      await tick()
    expect(requested.at(-1)).toBe(taskID)
    expect(detailRequested.at(-1)).toBe(taskID)
    expect(state.data.selectedTaskID).toBe(taskID)
    expect(state.data.effortBasis).toBeUndefined()
    expect(state.data.effortError).toContain("Categorized task effort is unavailable")
    await state.refresh()
    expect(state.data.selectedTaskID).toBeNull()
    expect(state.data.task).toBeUndefined()
    expect(state.data.effortBasis).toBeUndefined()
  } finally {
    state.close()
  }
})
