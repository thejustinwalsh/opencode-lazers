import { expect, test } from "bun:test"
import {
  CONFIG_ONE,
  CONFIG_SINGLE,
  CONFIG_ZERO,
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
  expect(ModelsDecision.id).toBe("lazers.models.decision.v1")
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
  expect(inspect.estimate.confidenceInterval).toBeNull()
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
  expect(contract.MODELS_DECISION_CONTRACT_VERSION).toBe(1)
  expect(globalThis.document).toBeUndefined()
})
