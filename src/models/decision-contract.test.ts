import { expect, test } from "bun:test"
import {
  CONFIG_ONE,
  CONFIG_SINGLE,
  CONFIG_ZERO,
  DECISION_ATTEMPT_ID,
  DECISION_TASK_ID,
  decisionConfigurations,
  decisionContext,
  decisionInspect,
  decisionOverview,
  decisionRead,
  decisionRow,
  decisionRows,
  zeroAcceptedNumericGraphPoint,
  singleEstimate,
} from "../../test/models-decision/fixtures/decision.ts"
import {
  MODELS_DECISION_RPC_ID,
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionContextSchema,
  ModelDecisionConfigurationSchema,
  ModelDecisionEstimateSchema,
  ModelDecisionInspectInputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionGraphPointSchema,
  ModelDecisionRowSchema,
  ModelDecisionRowsOutputSchema,
  ModelsDecision,
} from "./decision-contract.ts"
import type { ModelDecisionReader } from "./decision-contract.ts"

test("versioned reads share producer context while the global graph stays independent of row pages", () => {
  const overview = ModelDecisionOverviewOutputSchema.parse(decisionOverview())
  const rows = ModelDecisionRowsOutputSchema.parse(decisionRows())
  const configurations = ModelDecisionConfigurationsOutputSchema.parse(decisionConfigurations())
  const inspect = ModelDecisionInspectOutputSchema.parse(decisionInspect())

  expect(ModelsDecision.id).toBe(MODELS_DECISION_RPC_ID)
  expect(ModelsDecision.id).toBe("lazers.models.decision.v2")
  for (const output of [overview, rows, configurations]) {
    expect(output.context.snapshotID).toBe("snapshot:producer-owned/42")
    expect(output.context.filters).toEqual(decisionRead.filters)
    expect(output.context.accounting.acceptanceThreshold).toBeNull()
    expect(output.context.accounting.sampleSizeThreshold).toBeNull()
    expect(output.context.accounting.numerator).toContain("failed-retry")
  }
  expect(rows.rows).toHaveLength(1)
  expect(rows.nextCursor).toBe("rows:opaque-next")
  expect(overview.graph.scope).toBe("global-filtered-snapshot")
  expect(overview.graph.points.map((point) => point.configurationID)).toEqual([
    CONFIG_ONE,
    CONFIG_SINGLE,
  ])
  expect(overview.graph.points.some((point) => point.configurationID === CONFIG_ZERO)).toBe(false)
  expect(overview.graph.frontierConfigurationIDs).toEqual([CONFIG_ONE])
  expect(rows.rows[0]?.configuration.route).toEqual({
    providerID: "openai",
    modelID: "gpt-6",
    variant: "high",
  })
  expect(rows.rows[0]?.configuration.currentPrice.source).toBe("openrouter")
  expect(configurations.configurations[0]?.configurationID).toBe(CONFIG_ONE)

  if (inspect.status !== "found") throw new Error("Expected a found inspection fixture")
  expect(inspect.configuration.configurationID).toBe(CONFIG_ONE)
  expect(inspect.contributorPage.contributors[0]).toMatchObject({
    taskID: DECISION_TASK_ID,
    taskReference: "LZ-42",
    sessionID: "ses-synthetic-contributor",
  })
  expect(inspect.contributorPage.nextCursor).toBe("contributors:opaque-next")
  expect(inspect.nativeReportedCost.totalUSD).toBe(0.071)
  expect(inspect.efficiency.status).toBe("available")
  expect(inspect.context.priceIndex).toMatchObject({
    source: "openrouter",
    freshness: "current",
    semantics: "exact-published-route-quotes",
  })
  expect(inspect.configuration.currentPrice.semantics).toBe("exact-route-quote")
  expect(inspect.estimate.status).toBe("available")
  expect(inspect.estimate.historyScope).toBeUndefined()
  expect(inspect.contributorPage.contributors[0]?.route).toBeUndefined()
  expect(inspect.contributorPage.contributors[0]?.membership).toBeUndefined()
  expect(inspect.estimate.confidenceInterval).toBeNull()
})

test("inspection distinguishes complete accepted-task retry history and contributor membership", () => {
  const base = decisionInspect()
  if (base.status !== "found") throw new Error("Expected a found inspection fixture")

  const routeA = {
    providerID: "anthropic",
    modelID: "claude-3-7-sonnet",
    variant: "extended",
  }
  const routeB = base.configuration.route
  const historyScope = {
    completeness: "complete-accepted-logical-task-retry-history" as const,
    routeScope: "cross-route" as const,
  }
  const contributor = base.contributorPage.contributors[0]!
  const aFailed = {
    ...contributor,
    taskID: DECISION_TASK_ID,
    taskReference: "LZ-42",
    attemptID: "33333333-3333-4333-8333-333333333333",
    sessionID: "ses-route-a-failure",
    contribution: "failed" as const,
    route: routeA,
    membership: "empirical-history" as const,
  }
  const bAccepted = {
    ...contributor,
    taskID: DECISION_TASK_ID,
    taskReference: "LZ-42",
    attemptID: DECISION_ATTEMPT_ID,
    sessionID: "ses-route-b-acceptance",
    contribution: "accepted" as const,
    route: routeB,
    membership: "both" as const,
  }
  const cohortOnly = {
    ...contributor,
    taskID: "44444444-4444-4444-8444-444444444444",
    taskReference: "LZ-43",
    attemptID: "55555555-5555-4555-8555-555555555555",
    sessionID: "ses-route-b-unaccepted-task",
    contribution: "failed" as const,
    route: routeB,
    membership: "cohort-effort" as const,
  }
  const crossRouteInspection = {
    ...base,
    selectedTaskID: DECISION_TASK_ID,
    estimate: { ...base.estimate, historyScope },
    contributorPage: {
      ...base.contributorPage,
      contributors: [aFailed, bAccepted, cohortOnly],
    },
  }

  const parsed = ModelDecisionInspectOutputSchema.parse(crossRouteInspection)
  if (parsed.status !== "found") throw new Error("Expected a found inspection fixture")
  expect(parsed.selectedTaskID).toBe(DECISION_TASK_ID)
  expect(parsed.estimate.historyScope).toEqual(historyScope)
  expect(parsed.contributorPage.contributors).toMatchObject([
    {
      taskID: DECISION_TASK_ID,
      contribution: "failed",
      route: routeA,
      membership: "empirical-history",
    },
    {
      taskID: DECISION_TASK_ID,
      contribution: "accepted",
      route: routeB,
      membership: "both",
    },
    {
      contribution: "failed",
      membership: "cohort-effort",
    },
  ])
  expect(parsed.contributorPage.contributors[0]?.route).not.toEqual(
    parsed.contributorPage.contributors[1]?.route,
  )

  for (const routeScope of ["same-route", "cross-route", "mixed", "unknown"] as const) {
    const scopedContributors =
      routeScope === "unknown"
        ? [
            { ...aFailed, route: null },
            { ...bAccepted, route: null },
            { ...cohortOnly, route: null },
          ]
        : routeScope === "same-route"
          ? [{ ...aFailed, route: routeB }, bAccepted, cohortOnly]
          : routeScope === "mixed"
            ? [
                aFailed,
                bAccepted,
                cohortOnly,
                {
                  ...bAccepted,
                  taskID: "66666666-6666-4666-8666-666666666666",
                  taskReference: "LZ-44",
                  attemptID: "77777777-7777-4777-8777-777777777777",
                  sessionID: "ses-route-b-same-route-acceptance",
                },
              ]
            : [aFailed, bAccepted, cohortOnly]
    const scoped = ModelDecisionInspectOutputSchema.parse({
      ...crossRouteInspection,
      estimate: {
        ...crossRouteInspection.estimate,
        historyScope: { ...historyScope, routeScope },
      },
      contributorPage: {
        ...crossRouteInspection.contributorPage,
        contributors: scopedContributors,
      },
    })
    if (scoped.status !== "found") throw new Error("Expected a found inspection fixture")
    expect(scoped.estimate.historyScope?.routeScope).toBe(routeScope)
  }

  const legacyInspection = ModelDecisionInspectOutputSchema.parse(base)
  if (legacyInspection.status !== "found") throw new Error("Expected a found inspection fixture")
  expect(legacyInspection.estimate.historyScope).toBeUndefined()
  const explicitUnknown = ModelDecisionInspectOutputSchema.parse({
    ...base,
    estimate: {
      ...base.estimate,
      historyScope: {
        completeness: "complete-accepted-logical-task-retry-history",
        routeScope: "unknown",
      },
    },
    contributorPage: {
      ...base.contributorPage,
      contributors: [{ ...contributor, route: null }],
    },
  })
  if (explicitUnknown.status !== "found") throw new Error("Expected a found inspection fixture")
  expect(explicitUnknown.estimate.historyScope?.routeScope).toBe("unknown")
  expect(explicitUnknown.contributorPage.contributors[0]?.route).toBeNull()
  const explicitNull = ModelDecisionInspectOutputSchema.parse({
    ...base,
    estimate: { ...base.estimate, historyScope: null },
  })
  if (explicitNull.status !== "found") throw new Error("Expected a found inspection fixture")
  expect(explicitNull.estimate.historyScope).toBeNull()
  expect(explicitNull.estimate.historyScope).not.toEqual({
    ...historyScope,
    routeScope: "same-route",
  })

  expect(
    ModelDecisionInspectOutputSchema.safeParse({
      ...crossRouteInspection,
      estimate: {
        ...crossRouteInspection.estimate,
        historyScope: { ...historyScope, routeScope: "mostly-same-route" },
      },
    }).success,
  ).toBe(false)
  expect(
    ModelDecisionInspectOutputSchema.safeParse({
      ...crossRouteInspection,
      contributorPage: {
        ...crossRouteInspection.contributorPage,
        contributors: [{ ...aFailed, membership: "cohort" }],
      },
    }).success,
  ).toBe(false)
  expect(
    ModelDecisionInspectOutputSchema.safeParse({
      ...crossRouteInspection,
      contributorPage: {
        ...crossRouteInspection.contributorPage,
        contributors: [{ ...aFailed, route: { providerID: "openai", modelID: 7, variant: null } }],
      },
    }).success,
  ).toBe(false)
})

test("source-aware decision context preserves whole-model policy, mixed source pins, and unavailable prices", () => {
  const mixed = ModelDecisionContextSchema.parse(
    decisionContext({
      priceSourcePolicy: {
        schemaVersion: 1,
        revision: 7,
        sources: ["opencode", "openrouter"],
        fallback: "whole-model",
      },
      priceIndex: {
        source: "mixed",
        sourcePolicyRevision: 7,
        pins: [
          {
            source: "openrouter",
            snapshotID: "openrouter:real-source-snapshot/17",
            retrievedAt: "2026-11-03T11:55:00.000Z",
            freshness: "current",
            semantics: "exact-published-route-quotes",
          },
          {
            source: "opencode",
            snapshotID: "native-catalog:real-source-snapshot/18",
            retrievedAt: "2026-11-03T11:56:00.000Z",
            freshness: "stale",
            semantics: "exact-native-model-quotes",
          },
        ],
        freshness: "stale",
        semantics: "mixed",
        note: "Different configurations use complete quotes from their selected source.",
      },
    }),
  )
  expect(mixed.priceSourcePolicy).toMatchObject({
    revision: 7,
    sources: ["opencode", "openrouter"],
    fallback: "whole-model",
  })
  expect(mixed.priceIndex).toMatchObject({
    source: "mixed",
    sourcePolicyRevision: 7,
    pins: [
      { source: "openrouter", snapshotID: "openrouter:real-source-snapshot/17" },
      { source: "opencode", snapshotID: "native-catalog:real-source-snapshot/18" },
    ],
  })
  expect(
    ModelDecisionOverviewOutputSchema.parse({ ...decisionOverview(), context: mixed }).context
      .priceIndex.pins,
  ).toHaveLength(2)

  const noSources = {
    schemaVersion: 1 as const,
    revision: 8,
    sources: [] as Array<"openrouter" | "opencode">,
    fallback: "whole-model" as const,
  }
  const unavailable = ModelDecisionContextSchema.parse(
    decisionContext({
      priceSourcePolicy: noSources,
      priceIndex: {
        source: "unavailable",
        sourcePolicyRevision: 8,
        pins: [],
        freshness: "unavailable",
        semantics: "unknown",
        note: "No price sources are enabled.",
      },
    }),
  )
  expect(unavailable.priceIndex).toMatchObject({
    source: "unavailable",
    pins: [],
    freshness: "unavailable",
  })

  const noQuote = ModelDecisionConfigurationSchema.parse({
    ...decisionRow({
      status: "unknown",
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
      observationCount: 0,
      reason: "No attributable cohort.",
    }).configuration,
    currentPrice: {
      source: null,
      sourcePolicyRevision: 8,
      sourceRecordID: null,
      snapshotID: null,
      retrievedAt: null,
      semantics: "unknown",
      freshness: "unavailable",
    },
  })
  expect(noQuote.currentPrice).toMatchObject({ source: null, freshness: "unavailable" })
  expect(
    ModelDecisionConfigurationsOutputSchema.parse({
      ...decisionConfigurations(),
      context: unavailable,
      configurations: [noQuote],
    }).configurations[0]?.currentPrice,
  ).toMatchObject({ source: null, sourcePolicyRevision: 8, freshness: "unavailable" })

  expect(
    ModelDecisionContextSchema.safeParse(
      decisionContext({
        priceIndex: {
          ...decisionContext().priceIndex,
          source: "mixed",
        },
      }),
    ).success,
  ).toBe(false)
  expect(
    ModelDecisionContextSchema.safeParse(
      decisionContext({
        priceSourcePolicy: { ...noSources, sources: ["opencode"] },
        priceIndex: {
          ...decisionContext().priceIndex,
          sourcePolicyRevision: 8,
        },
      }),
    ).success,
  ).toBe(false)
  expect(
    ModelDecisionContextSchema.safeParse(
      decisionContext({
        priceSourcePolicy: { ...decisionContext().priceSourcePolicy, revision: 4 },
      }),
    ).success,
  ).toBe(false)
  expect(
    ModelDecisionContextSchema.safeParse(
      decisionContext({
        priceSourcePolicy: { ...noSources, fallback: "category-blending" } as never,
      }),
    ).success,
  ).toBe(false)
})

test("native-reported zero and execution route do not imply an available price source", () => {
  const base = decisionRow({
    status: "unknown",
    tokensPerAcceptedTask: null,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: 0,
    reason: "No attributable cohort.",
  })
  const row = {
    ...base,
    configuration: {
      ...base.configuration,
      currentPrice: {
        source: null,
        sourcePolicyRevision: 0,
        sourceRecordID: null,
        snapshotID: null,
        retrievedAt: null,
        semantics: "unknown" as const,
        freshness: "unavailable" as const,
      },
    },
    nativeReportedCost: {
      status: "available" as const,
      totalUSD: 0,
      source: "native-reported" as const,
      note: "A subscription-reported zero is not a market quote.",
    },
  }
  const parsed = ModelDecisionRowsOutputSchema.parse({ ...decisionRows(), rows: [row] }).rows[0]!
  expect(parsed.configuration.route.providerID).toBe("openai")
  expect(parsed.configuration.currentPrice).toMatchObject({
    source: null,
    freshness: "unavailable",
  })
  expect(parsed.nativeReportedCost.totalUSD).toBe(0)

  const stalePin = {
    ...decisionRow({
      status: "unknown",
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
      observationCount: 0,
      reason: "No attributable cohort.",
    }),
    configuration: {
      ...base.configuration,
      currentPrice: { ...base.configuration.currentPrice, sourcePolicyRevision: 1 },
    },
  }
  expect(
    ModelDecisionRowsOutputSchema.safeParse({ ...decisionRows(), rows: [stalePin] }).success,
  ).toBe(false)
})

test("zero accepted, one observation, partial, unknown, stale and backend-not-ready remain distinct", () => {
  const zero = ModelDecisionRowsOutputSchema.parse({
    ...decisionRows(),
    rows: [
      decisionRow(
        {
          status: "zero-accepted",
          tokensPerAcceptedTask: null,
          currentMarketUSDPerAcceptedTask: null,
          observationCount: 4,
        },
        CONFIG_ZERO,
      ),
    ],
  }).rows[0]!
  expect(zero.cohort.acceptedTaskCount).toBe(0)
  expect(zero.cohort.failedAttemptCount).toBeGreaterThan(0)
  expect(zero.efficiency).toMatchObject({
    status: "zero-accepted",
    tokensPerAcceptedTask: null,
    currentMarketUSDPerAcceptedTask: null,
  })
  expect(
    ModelDecisionRowsOutputSchema.safeParse({
      ...decisionRows(),
      rows: [
        decisionRow({
          status: "zero-accepted",
          tokensPerAcceptedTask: 0,
          currentMarketUSDPerAcceptedTask: 0,
          observationCount: 4,
        } as unknown as Parameters<typeof decisionRow>[0]),
      ],
    }).success,
  ).toBe(false)

  const single = ModelDecisionRowsOutputSchema.parse({
    ...decisionRows(),
    rows: [
      decisionRow({
        status: "single-observation",
        tokensPerAcceptedTask: 20_000,
        currentMarketUSDPerAcceptedTask: 0.08,
        observationCount: 1,
      }),
    ],
  }).rows[0]!
  expect(single.efficiency.status).toBe("single-observation")
  expect(ModelDecisionEstimateSchema.parse(singleEstimate)).toMatchObject({
    status: "single-observation",
    observationCount: 1,
    range: {
      tokens: { minimum: 20_000, maximum: 20_000 },
      currentMarketUSD: { minimum: 0.08, maximum: 0.08 },
    },
  })
  expect(
    ModelDecisionEstimateSchema.safeParse({
      ...singleEstimate,
      range: {
        tokens: { minimum: 10_000, maximum: 30_000 },
        currentMarketUSD: { minimum: 0.04, maximum: 0.12 },
      },
    }).success,
  ).toBe(false)

  const partial = ModelDecisionRowsOutputSchema.parse({
    ...decisionRows(),
    rows: [
      decisionRow({
        status: "partial",
        tokensPerAcceptedTask: 12_345.5,
        currentMarketUSDPerAcceptedTask: null,
        observationCount: 8,
        missing: ["current-price"],
      }),
    ],
  }).rows[0]!
  const unknown = ModelDecisionRowsOutputSchema.parse({
    ...decisionRows(),
    rows: [
      decisionRow({
        status: "unknown",
        tokensPerAcceptedTask: null,
        currentMarketUSDPerAcceptedTask: null,
        observationCount: 0,
        reason: "Classification is not available.",
      }),
    ],
  }).rows[0]!
  expect(partial.efficiency.status).toBe("partial")
  expect(unknown.efficiency.status).toBe("unknown")
  expect(decisionRows().context).toMatchObject({ availability: "partial", freshness: "stale" })
  expect(
    ModelDecisionContextSchema.parse(
      decisionContext({
        availability: "backend-not-ready",
        freshness: "unknown",
        unavailableReason: "Decision projection migrations have not completed.",
        classification: {
          status: "backend-not-ready",
          classifiedTaskCount: 0,
          unclassifiedTaskCount: 0,
          excludedTaskCount: 0,
          totalTaskCount: 0,
        },
      }),
    ),
  ).toMatchObject({ availability: "backend-not-ready", freshness: "unknown" })
})

test("zero accepted tasks have no numeric graph coordinates or row efficiencies", () => {
  const partialFlags = [false, true]
  const tokenCoordinates = [0, 12_345]
  const priceCoordinates = [0, 0.123456]

  for (const partial of partialFlags) {
    for (const tokensPerAcceptedTask of tokenCoordinates) {
      for (const currentMarketUSDPerAcceptedTask of priceCoordinates) {
        const point = {
          ...zeroAcceptedNumericGraphPoint,
          partial,
          tokensPerAcceptedTask,
          currentMarketUSDPerAcceptedTask,
        }
        expect(ModelDecisionGraphPointSchema.safeParse(point).success).toBe(false)
        expect(
          ModelDecisionOverviewOutputSchema.safeParse({
            ...decisionOverview(),
            graph: {
              ...decisionOverview().graph,
              points: [point],
            },
          }).success,
        ).toBe(false)
      }
    }
  }

  expect(
    ModelDecisionGraphPointSchema.parse({ ...zeroAcceptedNumericGraphPoint, acceptedTaskCount: 1 }),
  ).toMatchObject({
    acceptedTaskCount: 1,
    tokensPerAcceptedTask: 0,
    currentMarketUSDPerAcceptedTask: 0,
  })

  const zeroAcceptedRow = decisionRow({
    status: "zero-accepted",
    tokensPerAcceptedTask: null,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: 4,
  })
  expect(ModelDecisionRowSchema.parse(zeroAcceptedRow).cohort.acceptedTaskCount).toBe(0)
  expect(
    ModelDecisionRowsOutputSchema.parse({ ...decisionRows(), rows: [zeroAcceptedRow] }).rows,
  ).toHaveLength(1)

  const zeroAcceptedInspect = {
    ...decisionInspect(),
    ...zeroAcceptedRow,
    estimate: {
      status: "zero-accepted" as const,
      basis: "no-successful-task-efficiency" as const,
      observationCount: 4,
      range: { tokens: null, currentMarketUSD: null },
      confidenceInterval: null,
    },
  }
  expect(ModelDecisionInspectOutputSchema.parse(zeroAcceptedInspect).status).toBe("found")

  for (const [tokensPerAcceptedTask, currentMarketUSDPerAcceptedTask] of [
    [0, 0],
    [0, 0.12],
    [12_345, 0],
  ]) {
    const numericEfficiency = {
      status: "partial" as const,
      tokensPerAcceptedTask,
      currentMarketUSDPerAcceptedTask,
      observationCount: 4,
      missing: ["attribution" as const],
    }
    const invalidRow = { ...zeroAcceptedRow, efficiency: numericEfficiency }
    const invalidInspect = { ...zeroAcceptedInspect, efficiency: numericEfficiency }
    expect(ModelDecisionRowSchema.safeParse(invalidRow).success).toBe(false)
    expect(
      ModelDecisionRowsOutputSchema.safeParse({ ...decisionRows(), rows: [invalidRow] }).success,
    ).toBe(false)
    expect(ModelDecisionInspectOutputSchema.safeParse(invalidInspect).success).toBe(false)
  }
})

test("the reader is injectable and inspection binds snapshot, exact configuration and contributor paging", async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const reader: ModelDecisionReader = {
    overview: async (input, options) => {
      expect(input).toEqual(decisionRead)
      expect(options?.signal).toBe(controller.signal)
      calls.push("overview")
      return decisionOverview()
    },
    rows: async () => {
      calls.push("rows")
      return decisionRows()
    },
    configurations: async () => {
      calls.push("configurations")
      return decisionConfigurations()
    },
    inspect: async () => {
      calls.push("inspect")
      return decisionInspect()
    },
  }
  await reader.overview(decisionRead, { signal: controller.signal })
  await reader.rows({ ...decisionRead, limit: 1, cursor: "rows:opaque-next" })
  await reader.configurations({ ...decisionRead, limit: 100 })
  const inspection = ModelDecisionInspectInputSchema.parse({
    ...decisionRead,
    snapshotID: "snapshot:producer-owned/42",
    configurationID: CONFIG_ONE,
    selectedTaskID: DECISION_TASK_ID,
    contributorCursor: "contributors:opaque-next",
  })
  await reader.inspect(inspection)
  expect(calls).toEqual(["overview", "rows", "configurations", "inspect"])
  expect(inspection.configurationID).toBe(CONFIG_ONE)
  expect(inspection.selectedTaskID).toBe(DECISION_TASK_ID)
  expect(inspection.contributorLimit).toBe(50)
})

test("contract import is schema/RPC-only and has no DOM, database, chart or scoring dependency", async () => {
  const source = await Bun.file(new URL("./decision-contract.ts", import.meta.url)).text()
  expect(source).not.toMatch(/from ["'](?:echarts|node:sqlite|.*storage|.*comparison-chart)/)
  expect(source).not.toMatch(/\b(?:document|window|echarts|score|rank)\s*\(/)
  const contract = await import("./decision-contract.ts")
  expect(contract.MODELS_DECISION_CONTRACT_VERSION).toBe(2)
  expect(globalThis.document).toBeUndefined()
})
