import type {
  ModelDecisionConfigurations,
  ModelDecisionContext,
  ModelDecisionContributorPage,
  ModelDecisionEstimate,
  ModelDecisionGraphPoint,
  ModelDecisionInspect,
  ModelDecisionOverview,
  ModelDecisionReadInput,
  ModelDecisionRow,
  ModelDecisionRows,
} from "../../../src/models/decision-contract.ts"

export const DECISION_TASK_ID = "11111111-1111-4111-8111-111111111111"
export const DECISION_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"
export const CONFIG_ONE = "configuration:openai/gpt-6::high:opaque/1"
export const CONFIG_SINGLE = "configuration:qwen/qwen-7::none:opaque/2"
export const CONFIG_ZERO = "configuration:sonnet::zero:opaque/3"
export const GROUP_ONE = "group:openai/gpt-6:opaque"

export const decisionRead: ModelDecisionReadInput = {
  scope: { projectDirectory: "/synthetic/models" },
  filters: {
    persona: "ui",
    taskKind: "feature-implementation",
    period: { from: "2026-10-01T00:00:00.000Z", to: null },
  },
}

export function decisionContext(change: Partial<ModelDecisionContext> = {}): ModelDecisionContext {
  return {
    schemaVersion: 1,
    snapshotID: "snapshot:producer-owned/42",
    producedAt: "2026-11-03T12:00:00.000Z",
    ...decisionRead,
    availability: "ready",
    freshness: "current",
    unavailableReason: null,
    accounting: {
      id: "attributable-cohort-effort-per-accepted-logical-task-v1",
      numerator: "all-attributable-cohort-failed-retry-and-accepted-effort",
      denominator: "accepted-logical-tasks",
      acceptanceThreshold: null,
      sampleSizeThreshold: null,
      valuation: "current-common-openrouter-price-pins",
      nativeReportedCosts: "retained-separately-not-market-equivalent",
    },
    taskKindCatalog: {
      id: "task-kind/v1",
      kinds: [
        "bug-repair",
        "feature-implementation",
        "refactoring",
        "testing",
        "documentation",
        "maintenance",
      ],
    },
    classification: {
      status: "complete",
      classifiedTaskCount: 12,
      unclassifiedTaskCount: 0,
      excludedTaskCount: 2,
      totalTaskCount: 14,
    },
    priceIndex: {
      source: "openrouter",
      snapshotID: "openrouter:2026-11-03/current",
      retrievedAt: "2026-11-03T11:55:00.000Z",
      freshness: "current",
      semantics: "exact-published-route-quotes",
      note: "Current prices revalue the unchanged recorded token history.",
    },
    ...change,
  }
}

export const graphPoints: ModelDecisionGraphPoint[] = [
  {
    configurationID: CONFIG_ONE,
    groupID: GROUP_ONE,
    label: "GPT-6 · high",
    tokensPerAcceptedTask: 12_345.5,
    currentMarketUSDPerAcceptedTask: 0.123456,
    observationCount: 9,
    acceptedTaskCount: 8,
    partial: false,
  },
  {
    configurationID: CONFIG_SINGLE,
    groupID: "group:qwen/qwen-7",
    label: "Qwen 7",
    tokensPerAcceptedTask: 20_000,
    currentMarketUSDPerAcceptedTask: 0.08,
    observationCount: 1,
    acceptedTaskCount: 1,
    partial: false,
  },
]

export const zeroAcceptedNumericGraphPoint: ModelDecisionGraphPoint = {
  configurationID: CONFIG_ZERO,
  groupID: "group:sonnet",
  label: "Sonnet · no accepted tasks",
  tokensPerAcceptedTask: 0,
  currentMarketUSDPerAcceptedTask: 0,
  observationCount: 4,
  acceptedTaskCount: 0,
  partial: false,
}

export function decisionRow(
  efficiency: ModelDecisionRow["efficiency"],
  configurationID = CONFIG_ONE,
): ModelDecisionRow {
  const zero = efficiency.status === "zero-accepted"
  return {
    configuration: {
      configurationID,
      groupID: zero ? "group:sonnet" : GROUP_ONE,
      label: zero ? "Sonnet · no accepted tasks" : "GPT-6 · high",
      route: {
        providerID: zero ? "anthropic" : "openai",
        modelID: zero ? "sonnet" : "gpt-6",
        variant: zero ? null : "high",
      },
      currentPrice: {
        source: "openrouter",
        sourceRecordID: zero ? "anthropic/sonnet" : "openai/gpt-6",
        snapshotID: "openrouter:2026-11-03/current",
        retrievedAt: "2026-11-03T11:55:00.000Z",
        semantics: "exact-route-quote",
        freshness: "current",
      },
    },
    cohort: {
      logicalTaskCount: zero ? 4 : 10,
      classifiedTaskCount: zero ? 3 : 10,
      unclassifiedTaskCount: zero ? 1 : 0,
      acceptedTaskCount: zero ? 0 : 8,
      terminalTaskCount: zero ? 4 : 10,
      attemptCount: zero ? 7 : 14,
      failedAttemptCount: zero ? 7 : 6,
      retryAttemptCount: zero ? 3 : 4,
    },
    efficiency,
    nativeReportedCost: {
      status: "partial",
      totalUSD: 0.071,
      source: "native-reported",
      note: "Observed subscription/API charges are retained separately from market equivalence.",
    },
  }
}

export const contributorPage: ModelDecisionContributorPage = {
  contributors: [
    {
      taskID: DECISION_TASK_ID,
      taskReference: "LZ-42",
      attemptID: DECISION_ATTEMPT_ID,
      sessionID: "ses-synthetic-contributor",
      contribution: "retry",
      tokens: 4_500,
      currentMarketUSD: 0.045,
      nativeReportedUSD: 0.02,
      observedAt: "2026-11-02T10:00:00.000Z",
    },
  ],
  totalCount: 14,
  nextCursor: "contributors:opaque-next",
}

export const singleEstimate: ModelDecisionEstimate = {
  status: "single-observation",
  basis: "empirical-observed-spread",
  observationCount: 1,
  range: {
    tokens: { minimum: 20_000, maximum: 20_000 },
    currentMarketUSD: { minimum: 0.08, maximum: 0.08 },
  },
  confidenceInterval: null,
}

export function decisionOverview(): ModelDecisionOverview {
  return {
    context: decisionContext(),
    graph: {
      scope: "global-filtered-snapshot",
      points: graphPoints,
      frontierConfigurationIDs: [CONFIG_ONE],
    },
    configurationCount: 3,
    groupCount: 2,
  }
}

export function decisionRows(): ModelDecisionRows {
  return {
    context: decisionContext({ availability: "partial", freshness: "stale" }),
    rows: [
      decisionRow({
        status: "available",
        tokensPerAcceptedTask: 12_345.5,
        currentMarketUSDPerAcceptedTask: 0.123456,
        observationCount: 9,
      }),
    ],
    totalCount: 3,
    nextCursor: "rows:opaque-next",
  }
}

export function decisionConfigurations(): ModelDecisionConfigurations {
  return {
    context: decisionContext(),
    configurations: [
      decisionRow({
        status: "unknown",
        tokensPerAcceptedTask: null,
        currentMarketUSDPerAcceptedTask: null,
        observationCount: 0,
        reason: "No attributable cohort.",
      }).configuration,
    ],
    totalCount: 3,
    nextCursor: null,
  }
}

export function decisionInspect(): ModelDecisionInspect {
  const row = decisionRows().rows[0]!
  return {
    status: "found",
    context: decisionContext(),
    ...row,
    selectedTaskID: DECISION_TASK_ID,
    estimate: {
      status: "available",
      basis: "empirical-observed-spread",
      observationCount: 9,
      range: {
        tokens: { minimum: 9_000, maximum: 18_000 },
        currentMarketUSD: { minimum: 0.08, maximum: 0.2 },
      },
      confidenceInterval: null,
    },
    contributorPage,
  }
}
