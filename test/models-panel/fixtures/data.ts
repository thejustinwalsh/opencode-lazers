import { GetOutput, AgentQueryOutput } from "../../../src/tasks/contract.ts"
import { TaskSpecSchema } from "../../../src/task.ts"
import { ModelComparisonOutputSchema } from "../../../src/models/comparison-schema.ts"
import type { ModelComparisonOutput } from "../../../src/models/comparison-schema.ts"
import { ModelEvidenceOutputSchema } from "../../../src/models/source-schema.ts"
import { TaskEffortBasisSchema } from "../../../src/models/comparison-presentation.ts"
import { ModelSettingsOutputSchema } from "../../../src/models/contract.ts"

export const TASK_A = "11111111-1111-4111-8111-111111111111"
export const TASK_B = "22222222-2222-4222-8222-222222222222"
export const PROJECT_A = "project-a"
export const PROJECT_B = "project-b"
export const DIRECTORY_A = "/workspace/project-a"
export const DIRECTORY_B = "/workspace/project-b"
export const CANDIDATE_A = "6:openai|5:gpt-6|-"
export const CANDIDATE_A_SECOND = "6:openai|10:gpt-6-mini|-"
export const CANDIDATE_B = "9:anthropic|8:claude-4|-"
export const CANDIDATE_C = "6:openai|9:gpt-6-pro|-"
const legacyClassification = {
  revision: 0,
  classification: null,
  provenance: { kind: "legacy" },
} as const

const evidence = { records: [], recordCount: 0, truncated: false }
const sources = [
  "native-catalog",
  "openrouter-models",
  "openrouter-benchmarks",
  "models-dev",
  "epoch-benchmarks",
] as const

function candidate(
  providerID: string,
  modelID: string,
  name: string,
  variants: string[] | null = [],
  variantCoverage: ModelComparisonOutput["candidates"][number]["native"]["variantCoverage"] = {
    status: "complete",
    totalVariants: 0,
    omittedVariants: 0,
  },
) {
  return {
    candidateID: `${providerID.length}:${providerID}|${modelID.length}:${modelID}|-`,
    identity: { providerID, modelID, variant: null },
    native: {
      name,
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      availableVariants: variants,
      variantCoverage,
      prices: null,
      ambiguousIdentity: false,
      evidence,
    },
    correspondence: { status: "unresolved", basis: null, evidence },
    externalModel: null,
    externalModelEvidence: evidence,
    benchmarkCorrespondence: { status: "unresolved", basis: null, evidence },
    externalBenchmark: null,
    externalBenchmarkEvidence: evidence,
    effortApplicability: { status: "unknown", evidence },
  }
}

/** A model with one matched public benchmark row and an OpenRouter list price. */
function benchmarked(base: ReturnType<typeof candidate>) {
  const slug = `${base.identity.providerID}/${base.identity.modelID}`
  return {
    ...base,
    correspondence: { status: "exact", basis: "exact-published-catalog-id", evidence },
    externalModel: {
      kind: "openrouter-model",
      id: slug,
      canonicalSlug: slug,
      name: base.native.name,
      contextLength: 128_000,
      architecture: {
        modality: null,
        inputModalities: null,
        outputModalities: null,
        tokenizer: null,
        instructType: null,
      },
      supportedParameters: null,
      prices: {
        unit: "USD per token",
        tiers: [
          {
            minPromptTokens: null,
            utcStart: null,
            utcEnd: null,
            prompt: "0.0000004",
            completion: "0.0000016",
            inputCacheRead: "0.0000001",
            inputCacheWrite: null,
          },
        ],
      },
    },
    benchmarkCorrespondence: { status: "exact", basis: "published-canonical-slug", evidence },
    externalBenchmark: {
      kind: "openrouter-benchmark",
      source: "artificial-analysis",
      taskType: "coding",
      modelPermaslug: slug,
      displayName: `${base.native.name} (high)`,
      effort: null,
      codingIndex: 42.5,
      agenticIndex: 38,
      intelligenceIndex: null,
      prices: null,
    },
  }
}

export function comparison(projectID: string, revision: number, cursor?: string) {
  if (cursor)
    return ModelComparisonOutputSchema.parse({
      filters: {},
      sources: sources.map((source) => ({
        source,
        storage: "ready",
        snapshotState: "none",
        selectedSnapshotID: null,
        refresh: null,
        snapshot: null,
      })),
      candidates: [
        candidate("openai", "gpt-6-pro", "GPT-6 Pro page two", null, {
          status: "unknown",
          totalVariants: null,
          omittedVariants: null,
        }),
      ],
      totalCandidates: 3,
      nextCursor: null,
    })
  const firstCandidate =
    projectID === PROJECT_A
      ? candidate(
          "openai",
          "gpt-6",
          revision === 1 ? "GPT-6 cached" : "GPT-6 refreshed",
          Array.from({ length: 100 }, (_, index) => `effort-${index + 1}`),
          { status: "truncated", totalVariants: 105, omittedVariants: 5 },
        )
      : candidate("anthropic", "claude-4", "Claude 4 project B")
  const secondCandidate =
    projectID === PROJECT_A
      ? benchmarked(candidate("openai", "gpt-6-mini", "GPT-6 Mini"))
      : candidate("anthropic", "claude-4-sonnet", "Claude 4 Sonnet project B")

  return ModelComparisonOutputSchema.parse({
    filters: {},
    sources: sources.map((source) => ({
      source,
      storage: "ready",
      snapshotState: "none",
      selectedSnapshotID: null,
      refresh: null,
      snapshot: null,
    })),
    candidates: [firstCandidate, secondCandidate],
    totalCandidates: 3,
    nextCursor: "more-candidates",
  })
}

export function sourceEvidence() {
  return ModelEvidenceOutputSchema.parse({
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
}

export function taskPage(
  projectDirectory: string,
  taskID: string,
  reference: string,
  objective: string,
  sessionID: string,
) {
  return AgentQueryOutput.parse({
    projectDirectory,
    count: 1,
    tasks: [
      {
        taskID,
        reference,
        revision: 1,
        status: "submitted",
        reason: null,
        classification: legacyClassification,
        title: objective,
        objective,
        createdAt: "2026-11-03T00:00:00.000Z",
        sessionID,
        matches: [],
      },
    ],
    nextCursor: null,
    serverTime: "2026-11-03T00:00:00.000Z",
  })
}

export function taskDetail(
  taskID: string,
  projectID: string,
  projectDirectory: string,
  reference: string,
  objective: string,
) {
  const task = TaskSpecSchema.parse({
    schemaVersion: 1,
    id: taskID,
    revision: 1,
    status: "submitted",
    createdAt: "2026-11-03T00:00:00.000Z",
    provenance: {
      projectID,
      projectDirectory,
      workspaceDirectory: projectDirectory,
      sessionID: "ses-models-panel",
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
          id: "visible-result",
          assertion: "The task result is visible in the Models inspector.",
          evidence: [{ kind: "human", decision: "Verified by the panel integration test." }],
        },
      ],
      requirements: { capabilities: [], skills: [], risk: "low" },
      verification: [],
    },
  })
  return GetOutput.parse({
    status: "found",
    task,
    reference,
    classification: legacyClassification,
    classificationHistory: [legacyClassification],
    execution: {
      planID: "33333333-3333-4333-8333-333333333333",
      taskID,
      state: "accepted",
      version: 2,
      reason: null,
      waitingOn: [],
    },
  })
}

export function settings(projectDirectory: string, taskID: string | undefined, revision: number) {
  return ModelSettingsOutputSchema.parse({
    projectDirectory,
    taskID: taskID ?? null,
    personas: (["ui", "systems", "small-refactoring"] as const).map((persona) => {
      const assigned = Boolean(taskID) && persona === "ui"
      const target = assigned ? { scope: "task" as const, projectDirectory, taskID: taskID! } : null
      const route = assigned ? { providerID: "openai", id: `route-${revision}` } : null
      const record =
        assigned && target && route
          ? { schemaVersion: 1, target, persona, revision, route, updatedAt: revision }
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

/** The composed effort of a task (the `trajectory.effort` detail) with `tokens` observed. */
export function taskEffort(tokens: number) {
  const observedAt = Date.UTC(2026, 10, 3)
  const category = {
    value: tokens,
    unit: "tokens",
    status: "observed",
    valueScope: "task",
    sources: ["native-session-usage"],
    sourceTypes: ["cumulative-snapshot"],
    observationTimeBases: ["worker-session"],
    observedAtRange: { earliest: observedAt, latest: observedAt },
    observationCount: 1,
    missingObservations: 0,
  }
  const partialCategory = { ...category, status: "partial", missingObservations: 1 }
  const effort = TaskEffortBasisSchema.parse({
    schemaVersion: 1,
    basis: "panel integration fixture",
    attempts: { count: 1, states: [] },
    usage: {
      unit: "tokens",
      categories: {
        uncachedInput: partialCategory,
        output: category,
        reasoning: category,
        cacheRead: category,
        cacheWrite: category,
      },
      coverage: {
        totalUniqueSessions: 2,
        nativeCumulativeSnapshots: 1,
        retainedCumulativeSnapshots: 0,
        additiveStepSubtotals: 1,
        missingSessions: ["ses-route-missing"],
        unavailableSessions: ["ses-route-unavailable"],
        progressTruncated: true,
      },
    },
    routes: {
      assignments: [
        {
          attemptID: "attempt-route-1",
          state: "accepted",
          planSelection: {
            route: { providerID: "openai", modelID: "gpt-6", variant: null },
            status: "explicit",
            frozenComparison: "exact",
            source: "task-plan",
            meaning: "selected route recorded at plan time",
          },
          frozenAttemptRoute: {
            route: null,
            status: "unavailable",
            source: null,
            selectionSource: "not retained",
          },
          persona: {
            requested: "ui",
            requestedStatus: "requested",
            frozen: "ui",
            frozenStatus: "recorded",
            comparison: "match",
          },
        },
      ],
      assessments: [
        {
          attemptID: "attempt-route-1",
          sessionID: "ses-route-1",
          requestedRoute: { providerID: "openai", modelID: "gpt-6", variant: null },
          requestedRouteSource: "task-plan",
          observedRoute: null,
          scope: "session",
          source: "session-context",
          sourceType: "worker-session",
          observedAt,
          status: "unavailable",
          frozenRouteStatus: "unavailable",
        },
      ],
      usageAttribution: "Session-deduplicated usage includes partial evidence.",
      mixedRoutes: false,
      coverage: {
        totalUniqueSessions: 2,
        observedSessionRouteCount: 1,
        sessionsWithoutCurrentRoute: ["ses-route-missing"],
        observedStepRouteCount: 0,
        stepContextsByStatus: { available: 0, notRead: 1, unavailable: 1 },
        progressTruncated: true,
        truncatedContextSessionIDs: ["ses-route-1"],
        missingSessionIDs: ["ses-route-missing"],
        unavailableSessionIDs: ["ses-route-unavailable"],
      },
    },
    cost: {
      fullTaskCostUSD: { valueUSD: null, status: "unknown", meaning: "Not recorded" },
      marketEquivalentCostUSD: { valueUSD: null, status: "unknown", meaning: "Not recorded" },
    },
    quality: { status: "not-recorded", value: null, meaning: "Not recorded" },
  })
  return { taskEffortBasis: effort }
}
