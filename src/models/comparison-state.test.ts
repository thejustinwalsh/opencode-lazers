import { expect, test } from "bun:test"
import { GetOutput, AgentQueryOutput } from "../tasks/contract.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TaskDetail, TaskPage } from "../tasks/contract.ts"
import type { TrajectoryResponse } from "./comparison-state.ts"
import { ModelEvidenceOutputSchema } from "./source-schema.ts"
import type { ModelEvidenceOutput } from "./source-schema.ts"
import { ModelSettingsOutputSchema } from "./contract.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import { TaskEffortBasisSchema } from "./comparison-presentation.ts"
import type { ModelComparisonPanelData, ModelComparisonTransport } from "./comparison-state.ts"
import { ModelComparisonPanelState } from "./comparison-state.ts"

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

function tasks(taskIDs: string[], projectDirectory = "/repo"): TaskPage {
  return AgentQueryOutput.parse({
    projectDirectory,
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

/** The effort response is a plain shape now; the shim keeps the literals below as they were. */
const TrajectoryOutput = { parse: (value: unknown) => value as TrajectoryResponse }

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
    refreshSources: async () => evidence(),
    settings: async (taskID) => settings(taskID),
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

/** What the assignments stream would hand the state for its selected task. */
const readback = (state: ModelComparisonPanelState) =>
  (state as unknown as { transport: ModelComparisonTransport }).transport.settings(
    state.data.selectedTaskID ?? undefined,
    new AbortController().signal,
  )

const panelErrorMessage = "Observation scope is too large; narrow it"
const rejectPanelRPC = async () => {
  throw { type: "observation_error", data: { message: panelErrorMessage } }
}
const panelErrorCases = [
  { field: "sourceRefreshError", overrides: { refreshSources: rejectPanelRPC } },
  { field: "tasksError", overrides: { queryTasks: rejectPanelRPC } },
  { field: "taskError", overrides: { getTask: rejectPanelRPC } },
  { field: "effortError", overrides: { trajectoryStatus: rejectPanelRPC } },
] satisfies Array<{
  field: keyof ModelComparisonPanelData
  overrides: Partial<ModelComparisonTransport>
}>

for (const { field, overrides } of panelErrorCases) {
  test(`F-S14-1 Models ${field} preserves the readable RPC envelope message`, async () => {
    const state = new ModelComparisonPanelState(() => {})
    try {
      state.connect(`rpc-error-${field}`, "project-a", "/repo", transport(overrides), {
        selectedTaskID: null,
        selectedCandidateID: null,
      })
      await until(() => Boolean(state.data[field]))
      expect(state.data[field]).not.toContain("[object Object]")
      expect(state.data[field]).toContain(panelErrorMessage)
    } finally {
      state.close()
    }
  })
}

test("the assignments stream's settings apply only to the selected task of this project", async () => {
  const state = new ModelComparisonPanelState(() => {})
  state.connect(
    "project-a",
    "project-a",
    "/repo",
    transport({ queryTasks: async () => tasks([idA, idB]) }),
    { selectedTaskID: idA, selectedCandidateID: null },
  )
  try {
    expect(state.data.settingsLoading).toBe(true)
    state.applySettings(settings(idB))
    expect(state.data.settings).toBeUndefined()
    state.applySettings({ ...settings(idA), projectDirectory: "/other" })
    expect(state.data.settings).toBeUndefined()
    state.applySettings(settings(idA))
    expect(state.data.settings?.taskID).toBe(idA)
    expect(state.data.settingsLoading).toBe(false)
    await until(() => state.data.tasks.length === 2)
    state.selectTask(idB)
    // A new task clears the old task's settings until its stream frame arrives.
    expect(state.data.settings).toBeUndefined()
    state.applySettings(settings(idB))
    expect(state.data.settings?.taskID).toBe(idB)
    state.settingsFailed("stream lost")
    expect(state.data.settingsError).toBe("stream lost")
  } finally {
    state.close()
  }
})

test("selections persist through the callback; filters, configuration and entry change in place", () => {
  const saved: unknown[] = []
  const state = new ModelComparisonPanelState(
    () => {},
    (selection) => saved.push(selection),
  )
  state.connect("project-a", "project-a", "/repo", transport(), {
    selectedTaskID: null,
    selectedCandidateID: null,
  })
  try {
    state.selectConfiguration("configuration:a")
    state.selectConfiguration("configuration:a")
    state.selectCandidate("external:model")
    state.setDecisionFilters({ persona: "ui", taskKind: null, period: { from: null, to: null } })
    expect(state.data).toMatchObject({
      selectedConfigurationID: "configuration:a",
      selectedCandidateID: "external:model",
      decisionFilters: { persona: "ui" },
    })
    expect(saved).toEqual([
      {
        selectedTaskID: null,
        selectedCandidateID: null,
        selectedConfigurationID: "configuration:a",
      },
      {
        selectedTaskID: null,
        selectedCandidateID: "external:model",
        selectedConfigurationID: "configuration:a",
      },
    ])
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
    state.applySettings(await readback(state))
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
    state.applySettings(await readback(state))
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
    state.applySettings(await readback(state))
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
    state.applySettings(await readback(state))
    const save = state.configureMapping("ui", "task", {
      providerID: "provider-a",
      id: "route-a-new",
    })
    await until(() => state.data.assignmentWrite?.status === "saving")

    state.selectTask(idB)
    state.applySettings(await readback(state))
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
