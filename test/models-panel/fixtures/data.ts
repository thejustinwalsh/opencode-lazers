import { GetOutput, QueryOutput } from "../../../src/tasks/contract.ts"
import { TaskSpecSchema } from "../../../src/task.ts"
import { TrajectoryOutput } from "../../../src/observability/contract.ts"
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

const evidence = { records: [], recordCount: 0, truncated: false }
const sources = ["native-catalog", "openrouter-models", "openrouter-benchmarks"] as const

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
      ? candidate("openai", "gpt-6-mini", "GPT-6 Mini")
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
  return QueryOutput.parse({
    projectDirectory,
    snapshot: 1,
    count: 1,
    tasks: [
      {
        taskID,
        reference,
        revision: 1,
        status: "submitted",
        reason: null,
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
  return GetOutput.parse({ status: "found", task, reference })
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

export function trajectory(projectID: string, taskID: string, tokens: number) {
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
    report: { task: { id: taskID }, effort: { taskEffortBasis: effort } },
  })
}
