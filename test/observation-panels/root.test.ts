import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Schema } from "effect"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join } from "node:path"
import {
  CANDIDATE_C,
  DIRECTORY_A,
  DIRECTORY_B,
  PROJECT_A,
  PROJECT_B,
  TASK_A,
  TASK_B,
  comparison,
  settings,
  sourceEvidence,
  taskDetail,
  taskPage,
  trajectory,
} from "../models-panel/fixtures/data.ts"
import {
  CONFIG_ONE,
  CONFIG_SINGLE,
  CONFIG_ZERO,
  decisionInspect as fixtureDecisionInspect,
  decisionOverview as fixtureDecisionOverview,
  decisionRow as fixtureDecisionRow,
  decisionRows as fixtureDecisionRows,
  singleEstimate,
} from "../models-decision/fixtures/decision.ts"
import { ModelCatalogOutputSchema } from "../../src/models/contract.ts"
import type {
  ModelDecisionConfiguration,
  ModelDecisionEstimate,
  ModelDecisionFilters,
  ModelDecisionInspect,
  ModelDecisionRow,
} from "../../src/models/decision-contract.ts"
import { ModelDecisionEstimateSchema } from "../../src/models/decision-contract.ts"
import { ModelDecisionReferenceEstimateSchema } from "../../src/models/reference-estimate.ts"
import { KnownUsageMarketSchema } from "../../src/models/market-range.ts"
import type { ModelDecisionReferenceEstimate } from "../../src/models/reference-estimate.ts"
import type { ModelMappingUpdate } from "../../src/models/mapping-schema.ts"
import { ModelSettingsService } from "../../src/models/service.ts"
import { registerModelTools } from "../../src/models/tools.ts"
import { TaskRepository } from "../../src/storage.ts"
import {
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionRowsOutputSchema,
} from "../../src/models/decision-contract.ts"

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

type RegisteredModelTool = Parameters<ToolEditor["add"]>[0]

function modelToolContext() {
  return {
    sessionID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))(
      "ses_models_panel",
    ),
    agent: Agent.ID.make("architect"),
    messageID: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Session.Message.ID")))(
      "msg_models_panel",
    ),
    id: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Tool.CallID")))(
      "call_models_panel",
    ),
    progress: () => Effect.void,
  } satisfies Parameters<RegisteredModelTool["execute"]>[1]
}

type PanelLocation = {
  project: { canonical: string; id: string }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

/** The selected model's name, plus its effort when the route has one. */
function selectedName(container: ParentNode) {
  const heading = container.querySelector(".lazers-details-header h2")
  if (!heading) return undefined
  const effort = container
    .querySelector(".lazers-models-selected-identity code")
    ?.textContent?.split(" · ")[1]
  return `${heading.textContent}${effort ? ` · ${effort}` : ""}`
}

function buttonWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  )
}

function menuItemWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) =>
    button.textContent?.includes(text),
  )
}

function fillTextInput(container: ParentNode, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`Missing text input: ${label}`)
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

function openRouterReference(
  route: ModelDecisionConfiguration["route"],
  status: "exact" | "conditional" | "partial",
  acceptedTaskCount: number,
): ModelDecisionReferenceEstimate {
  const common = {
    basis: "openrouter-published-model-reference-cost-per-accepted-task" as const,
    route,
    acceptedTaskCount,
    numeratorUSD: null,
    numeratorRangeUSD: null,
    valueUSDPerAcceptedTask: null,
    rangeUSDPerAcceptedTask: null,
    knownSubtotalUSD: null,
    knownSubtotalRangeUSD: null,
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: null,
    identityStatus: "exact" as const,
    provenance: {
      source: "openrouter-models" as const,
      policyRevision: 3,
      availability: "available" as const,
      access: "configured" as const,
      snapshotID: "33333333-3333-4333-8333-333333333333",
      generation: 7,
      retrievedAt: "2026-11-05T12:00:00.000Z",
      sourceURL: "https://openrouter.ai/api/v1/models",
      recordID: `${route.providerID}/${route.modelID}`,
      recordIndex: 2,
      freshness: "current" as const,
    },
    coverage: {
      categories: {
        uncachedInput: {
          tokens: 12_000,
          status: "observed" as const,
          rateCoverage: "complete" as const,
        },
        output: { tokens: 8_000, status: "observed" as const, rateCoverage: "complete" as const },
        reasoning: {
          tokens: 1_000,
          status: "observed" as const,
          rateCoverage: "complete" as const,
        },
        cacheRead: {
          tokens: 0,
          status: "observed" as const,
          rateCoverage: "not-required" as const,
        },
        cacheWrite: { tokens: 500, status: "observed" as const, rateCoverage: "complete" as const },
      },
      retries: {
        status: (status === "partial" ? "partial" : "complete") as "complete" | "partial",
        attemptCount: 11,
        failedAttemptCount: 2,
        retryAttemptCount: 3,
        attemptsWithCompleteUsage: status === "partial" ? 8 : 11,
        failedAttemptsWithCompleteUsage: 1,
        retryAttemptsWithCompleteUsage: status === "partial" ? 2 : 3,
      },
      attribution: {
        status: (status === "partial" ? "partial" : "complete") as "complete" | "partial",
        relatedTaskCount: acceptedTaskCount + 1,
        unknownRouteTaskCount: status === "partial" ? 1 : 0,
        relatedSessionCount: 11,
        matchedRouteSessionCount: 10,
        includedSessionCount: 9,
        otherRouteSessionCount: 1,
        mixedRouteSessionCount: status === "partial" ? 1 : 0,
        unknownRouteSessionCount: status === "partial" ? 1 : 0,
        sharedSessionCount: 0,
        unattributedSessionCount: status === "partial" ? 1 : 0,
      },
    },
    reasons: status === "partial" ? (["missing-rate", "partial-attribution"] as const) : [],
  }
  if (status === "exact")
    return ModelDecisionReferenceEstimateSchema.parse({
      ...common,
      status,
      numeratorUSD: acceptedTaskCount * 0.0000000000123,
      valueUSDPerAcceptedTask: 0.0000000000123,
    })
  if (status === "conditional")
    return ModelDecisionReferenceEstimateSchema.parse({
      ...common,
      status,
      numeratorRangeUSD: { minimum: 0.0000004, maximum: 0.0000012 },
      rangeUSDPerAcceptedTask: { minimum: 0.00000004, maximum: 0.00000012 },
    })
  return ModelDecisionReferenceEstimateSchema.parse({
    ...common,
    status,
    knownSubtotalUSD: acceptedTaskCount * 0.00000005,
    knownSubtotalUSDPerAcceptedTask: 0.00000005,
    coverage: {
      ...common.coverage,
      categories: {
        ...common.coverage.categories,
        cacheWrite: { tokens: null, status: "missing", rateCoverage: "missing" },
      },
    },
  })
}

type KnownUsageSource = "openrouter-endpoints" | "openrouter-models" | "native-catalog"

function knownUsageMarketForSource(
  route: ModelDecisionConfiguration["route"],
  source: KnownUsageSource,
) {
  const productID = `${route.providerID}/${route.modelID}`
  const sourceURL =
    source === "openrouter-endpoints"
      ? `https://openrouter.ai/${productID}/pricing`
      : source === "openrouter-models"
        ? "https://openrouter.ai/api/v1/models"
        : "https://opencode.ai/models"
  const priceBasis = source === "openrouter-models" ? "average" : "quote"
  const cacheWriteBasis =
    source === "openrouter-endpoints"
      ? "endpoint-rate"
      : source === "openrouter-models"
        ? "published-model-rate"
        : "published-native-quote"

  return KnownUsageMarketSchema.parse({
    schemaVersion: 1,
    scope: "known-retained-token-usage-only",
    route,
    identity: {
      status: "exact",
      productID,
      rules: [],
      basis: "exact-published-catalog-id",
      catalogSourceState: "available",
      evidence: {
        native: [],
        catalog: [],
        nativeRecordCount: 0,
        catalogRecordCount: 0,
        nativeTruncated: false,
        catalogTruncated: false,
      },
    },
    status: "exact",
    scenarios: [
      {
        id: "configured-current-market",
        label: "Configured current-market rates",
        status: "exact",
        freshness: "current",
        valueUSD: 0.00002,
        rangeUSD: null,
        knownSubtotalUSD: null,
        rateSets: [
          {
            tierID: "default",
            contextTierTokens: null,
            minPromptTokens: null,
            utcStart: null,
            utcEnd: null,
            prompt: "0.000002",
            completion: "0.00001",
            cacheRead: "0.0000002",
            cacheWrite: "0",
          },
        ],
        missingRates: [],
        cacheWriteEvidence: {
          basis: cacheWriteBasis,
          policyID: null,
          sourceURL: null,
          retrievedAt: null,
        },
        tierAttribution: {
          status: "not-required",
          basis: "single-published-rate-scenario",
          callCount: 0,
          selectedTierIDs: ["default"],
          promptThresholds: [],
          thresholdSemantics: null,
        },
        provenance: {
          source,
          productID,
          priceBasis,
          sourceURL,
          refreshState: "succeeded",
          snapshotID: "44444444-4444-4444-8444-444444444444",
          snapshotGeneration: 3,
          currentGeneration: 3,
          retrievedAt: "2026-11-06T12:00:00.000Z",
          recordIndex: 0,
          providerName: null,
          tag: productID,
          serviceTier: null,
        },
        coverage: {
          scope: "known-route-matched-retained-usage",
          wholeTaskBound: false,
          categories: {
            uncachedInput: { tokens: 10, status: "observed" },
            output: { tokens: 2, status: "observed" },
            reasoning: { tokens: 0, status: "observed" },
            cacheRead: { tokens: 3, status: "observed" },
            cacheWrite: { tokens: 0, status: "observed" },
          },
          route: {
            relatedSessionCount: 1,
            matchedRouteSessionCount: 1,
            includedSessionCount: 1,
            otherRouteSessionCount: 0,
            mixedRouteSessionCount: 0,
            unknownRouteSessionCount: 0,
            sharedSessionCount: 0,
          },
          retries: {
            status: "complete",
            attemptCount: 1,
            routeMatchedAttemptCount: 1,
            otherRouteAttemptCount: 0,
            mixedRouteAttemptCount: 0,
            unknownRouteAttemptCount: 0,
            sharedAttemptCount: 0,
            failedAttemptCount: 0,
            retryAttemptCount: 0,
            attemptsWithCompleteUsage: 1,
            failedAttemptsWithCompleteUsage: 0,
            retryAttemptsWithCompleteUsage: 0,
          },
        },
        reason: null,
      },
    ],
  })
}

const sourceHighDecisionRow = fixtureDecisionRows().rows[0]!
const highAcceptedTasks = sourceHighDecisionRow.efficiency.observationCount
const highReferenceEstimate = openRouterReference(
  sourceHighDecisionRow.configuration.route,
  "exact",
  highAcceptedTasks,
)
const highConfiguration: ModelDecisionConfiguration = {
  ...sourceHighDecisionRow.configuration,
  referenceEstimate: highReferenceEstimate,
}
const highDecisionRow: ModelDecisionRow = {
  ...sourceHighDecisionRow,
  configuration: highConfiguration,
  cohort: { ...sourceHighDecisionRow.cohort, acceptedTaskCount: highAcceptedTasks },
  efficiency: {
    status: "partial",
    tokensPerAcceptedTask: sourceHighDecisionRow.efficiency.tokensPerAcceptedTask,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: sourceHighDecisionRow.efficiency.observationCount,
    missing: ["current-price" as const],
  },
  referenceEstimate: highReferenceEstimate,
}
const lowRoute: ModelDecisionConfiguration["route"] = {
  ...highConfiguration.route,
  variant: "low",
}
const lowReferenceEstimate = openRouterReference(lowRoute, "conditional", highAcceptedTasks)
const lowConfiguration: ModelDecisionConfiguration = {
  ...highConfiguration,
  configurationID: "configuration:openai/gpt-6::low:opaque/2",
  label: "GPT-6 · low",
  route: lowRoute,
  referenceEstimate: lowReferenceEstimate,
}
const qwenConfiguration: ModelDecisionConfiguration = {
  ...highConfiguration,
  configurationID: CONFIG_SINGLE,
  groupID: "group:qwen/qwen-7",
  label: "Unverified Qwen alias · preview-effort",
  route: { providerID: "qwen", modelID: "qwen-7", variant: "preview-effort" },
  currentPrice: { ...highConfiguration.currentPrice, sourceRecordID: "qwen/qwen-7" },
  referenceEstimate: undefined,
}
const zeroConfiguration = fixtureDecisionRow(
  {
    status: "zero-accepted",
    tokensPerAcceptedTask: null,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: 7,
  },
  CONFIG_ZERO,
).configuration
const lowDecisionRow: ModelDecisionRow = {
  ...highDecisionRow,
  configuration: lowConfiguration,
  efficiency: {
    status: "partial",
    tokensPerAcceptedTask: 18_500,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: 4,
    missing: ["current-price"],
  },
  referenceEstimate: lowReferenceEstimate,
}
const qwenDecisionRow: ModelDecisionRow = {
  ...highDecisionRow,
  configuration: qwenConfiguration,
  efficiency: {
    status: "single-observation",
    tokensPerAcceptedTask: 20_000,
    currentMarketUSDPerAcceptedTask: 0.08,
    observationCount: 1,
  },
  cohort: { ...highDecisionRow.cohort, acceptedTaskCount: 1 },
  referenceEstimate: undefined,
}
const zeroDecisionRow: ModelDecisionRow = {
  ...fixtureDecisionRow(
    {
      status: "zero-accepted",
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
      observationCount: 7,
    },
    CONFIG_ZERO,
  ),
  configuration: zeroConfiguration,
}
const CONFIG_CROSS_ROUTE = "configuration:provider-b/model-b:50:opaque/cross-route"
const crossRouteConfiguration: ModelDecisionConfiguration = {
  ...highConfiguration,
  configurationID: CONFIG_CROSS_ROUTE,
  groupID: "group:provider-b/model-b",
  label: "Model B · 50",
  route: { providerID: "provider-b", modelID: "model-b", variant: "50" },
  referenceEstimate: undefined,
  currentPrice: {
    ...highConfiguration.currentPrice,
    sourceRecordID: "provider-b/model-b",
  },
}
const crossRouteDecisionRow: ModelDecisionRow = {
  ...highDecisionRow,
  configuration: crossRouteConfiguration,
  cohort: {
    logicalTaskCount: 1,
    classifiedTaskCount: 1,
    unclassifiedTaskCount: 0,
    acceptedTaskCount: 1,
    terminalTaskCount: 1,
    attemptCount: 1,
    failedAttemptCount: 0,
    retryAttemptCount: 0,
  },
  efficiency: {
    status: "single-observation",
    tokensPerAcceptedTask: 50,
    currentMarketUSDPerAcceptedTask: 0.00005,
    observationCount: 1,
  },
  nativeReportedCost: {
    status: "unknown",
    totalUSD: null,
    source: "native-reported",
    note: "No native-reported charge is available for this exact cohort.",
  },
  referenceEstimate: undefined,
}
const unknownPriceRoute: ModelDecisionConfiguration["route"] = {
  providerID: "unknown-provider",
  modelID: "model-identity-with-a-very-long-unrecognized-name",
  variant: null,
}
const longReferenceConfigurationID = "reference-only:provider-c/model-with-long-name"
const longReferenceRoute: ModelDecisionConfiguration["route"] = {
  providerID: "provider-c",
  modelID: "model-with-long-name",
  variant: "deep",
}
const longReferenceEstimate = openRouterReference(longReferenceRoute, "exact", 2)
const sharedNameNullRoute: ModelDecisionConfiguration["route"] = {
  providerID: "provider-a",
  modelID: "model-a",
  variant: null,
}
const sharedNameVariantRoute: ModelDecisionConfiguration["route"] = {
  ...sharedNameNullRoute,
  variant: "high",
}
const sharedNameOtherModelRoute: ModelDecisionConfiguration["route"] = {
  providerID: "provider-a",
  modelID: "model-c",
  variant: null,
}
const sharedNameNullConfigurationID = "reference-only:provider-a/model-a"
const sharedNameVariantConfigurationID = "reference-only:provider-a/model-a/high"
const sharedNameOtherModelConfigurationID = "reference-only:provider-a/model-c"
const sharedNameNullEstimate = openRouterReference(sharedNameNullRoute, "exact", 2)
const sharedNameVariantEstimate = openRouterReference(sharedNameVariantRoute, "exact", 2)
const sharedNameOtherModelEstimate = openRouterReference(sharedNameOtherModelRoute, "exact", 2)
const unknownReferenceEstimate = openRouterReference(unknownPriceRoute, "partial", 1)
const qwenReferenceEstimate = openRouterReference(qwenConfiguration.route, "partial", 1)
const unknownPriceConfiguration: ModelDecisionConfiguration = {
  ...highConfiguration,
  configurationID:
    "configuration:unknown-provider/model-identity-with-a-very-long-unrecognized-name",
  groupID: "group:unknown-provider/model-identity-with-a-very-long-unrecognized-name",
  label: "Misleading synthesized model label · high",
  route: unknownPriceRoute,
  referenceEstimate: unknownReferenceEstimate,
  currentPrice: {
    ...highConfiguration.currentPrice,
    source: null,
    sourceRecordID: null,
    snapshotID: null,
    retrievedAt: null,
    semantics: "unknown",
    freshness: "unavailable",
  },
}
const unknownPriceDecisionRow: ModelDecisionRow = {
  ...highDecisionRow,
  configuration: unknownPriceConfiguration,
  cohort: { ...highDecisionRow.cohort, acceptedTaskCount: 1 },
  efficiency: {
    status: "partial",
    tokensPerAcceptedTask: 24_000,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: 1,
    missing: ["current-price"],
  },
  referenceEstimate: unknownReferenceEstimate,
}
const crossRouteEstimate: ModelDecisionEstimate = {
  status: "single-observation",
  basis: "empirical-observed-spread",
  observationCount: 1,
  range: {
    tokens: { minimum: 150, maximum: 150 },
    currentMarketUSD: { minimum: 0.00015, maximum: 0.00015 },
  },
  confidenceInterval: null,
  historyScope: {
    completeness: "complete-accepted-logical-task-retry-history",
    routeScope: "cross-route",
  },
}
const crossRouteAContributor = {
  taskID: TASK_A,
  taskReference: "LZ-100",
  attemptID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionID: "ses-route-a",
  contribution: "retry" as const,
  route: { providerID: "provider-a", modelID: "model-a", variant: "100" },
  membership: "empirical-history" as const,
  tokens: 100,
  currentMarketUSD: 0.0001,
  nativeReportedUSD: null,
  observedAt: "2026-11-03T10:00:00.000Z",
}
const crossRouteBContributor = {
  taskID: TASK_A,
  taskReference: "LZ-100",
  attemptID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sessionID: "ses-route-b",
  contribution: "accepted" as const,
  route: { providerID: "provider-b", modelID: "model-b", variant: "50" },
  membership: "both" as const,
  tokens: 50,
  currentMarketUSD: 0.00005,
  nativeReportedUSD: null,
  observedAt: "2026-11-03T10:05:00.000Z",
}

const nativeModelCatalog = ModelCatalogOutputSchema.parse({
  source: "Live native OpenCode model catalog",
  observedAt: "2026-11-05T12:00:00Z",
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
    {
      providerID: "provider-b",
      id: "model-b",
      name: "GPT-6",
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: ["50"],
    },
    {
      providerID: "provider-a",
      id: "model-a",
      name: "GPT-6",
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: ["high"],
    },
    {
      providerID: "provider-a",
      id: "model-c",
      name: "GPT-6",
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: [],
    },
    {
      providerID: "provider-c",
      id: "model-with-long-name",
      name: "An unusually long catalog-backed model display name",
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: ["deep"],
    },
    {
      providerID: "openai",
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: ["max"],
    },
    {
      providerID: "qwen",
      id: "qwen-7",
      name: "Qwen 7",
      enabled: true,
      type: "chat",
      contextTokens: 128_000,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: ["high"],
    },
    {
      providerID: "anthropic",
      id: "claude-4",
      name: "Claude 4 Sonnet",
      enabled: true,
      type: "chat",
      contextTokens: 200_000,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      pricesUSDPerMillionTokens: null,
      variants: [],
    },
  ],
})

type NativePickerOptions = {
  title: string
  placeholder?: string
  current?: string
  options: readonly { title: string; value: string; description?: string; group?: string }[]
}

function decisionContextFor(
  filters: ModelDecisionFilters,
  directory: string,
  snapshotID: string,
  revision = 0,
) {
  return {
    ...fixtureDecisionOverview().context,
    snapshotID,
    producedAt: `2026-11-03T12:0${revision % 10}:00.000Z`,
    scope: { projectDirectory: directory },
    filters,
    availability: "ready" as const,
    freshness: "current" as const,
    unavailableReason: null,
  }
}

function decisionPointDelta(snapshotNumber: number, filters: ModelDecisionFilters) {
  return snapshotNumber * 125 + (filters.taskKind ? 1_000 : 0) + (filters.persona ? 250 : 0)
}

function shiftRange(range: { minimum: number; maximum: number } | null, delta: number) {
  return range ? { minimum: range.minimum + delta, maximum: range.maximum + delta } : null
}

function shiftDecisionRow(row: ModelDecisionRow, delta: number): ModelDecisionRow {
  switch (row.efficiency.status) {
    case "available":
    case "single-observation":
      return {
        ...row,
        efficiency: {
          ...row.efficiency,
          tokensPerAcceptedTask: row.efficiency.tokensPerAcceptedTask + delta,
          currentMarketUSDPerAcceptedTask:
            row.efficiency.currentMarketUSDPerAcceptedTask + delta / 100_000,
        },
      }
    case "partial":
      return {
        ...row,
        efficiency: {
          ...row.efficiency,
          tokensPerAcceptedTask:
            row.efficiency.tokensPerAcceptedTask === null
              ? null
              : row.efficiency.tokensPerAcceptedTask + delta,
          currentMarketUSDPerAcceptedTask:
            row.efficiency.currentMarketUSDPerAcceptedTask === null
              ? null
              : row.efficiency.currentMarketUSDPerAcceptedTask + delta / 100_000,
        },
      }
    case "zero-accepted":
    case "unknown":
      return row
  }
}

function shiftEstimate(estimate: ModelDecisionEstimate, delta: number): ModelDecisionEstimate {
  switch (estimate.status) {
    case "available":
    case "single-observation":
      return {
        ...estimate,
        range: {
          tokens: shiftRange(estimate.range.tokens, delta)!,
          currentMarketUSD: shiftRange(estimate.range.currentMarketUSD, delta / 100_000)!,
        },
      }
    case "partial":
      return {
        ...estimate,
        range: {
          tokens: shiftRange(estimate.range.tokens, delta),
          currentMarketUSD: shiftRange(estimate.range.currentMarketUSD, delta / 100_000),
        },
      }
    case "zero-accepted":
    case "unknown":
      return estimate
  }
}

test("gui.setup registers and mounts the real Models panel render with isolated, cancellable DOM state", async () => {
  const dom = new Window({ url: "http://localhost" })
  const browserDocument = dom.document as unknown as Document
  const globalNames = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLDivElement",
    "HTMLDetailsElement",
    "Document",
    "DocumentFragment",
    "Text",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "PointerEvent",
    "MutationObserver",
    "customElements",
    "navigator",
    "location",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const name of globalNames) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (dom as unknown as Record<string, unknown>)[name],
    })
  }

  const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
  const entry = fileURLToPath(new URL("../models-panel/fixtures/dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL("../../node_modules/.cache/models-panel-dom-test", import.meta.url),
  )
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  let replacedInferenceRuntime = false
  let disposeSetup: (() => void) | undefined
  let assignmentAuthorityDirectory: string | undefined
  let assignmentAuthorityRepository: TaskRepository | undefined
  const mounts: Array<{ dispose(): void }> = []
  try {
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
      plugins: [
        solid(),
        {
          name: "test-unused-inference-runtime",
          enforce: "pre",
          resolveId(source, importer) {
            if (source !== "./webgpu/runtime.ts" || importer !== guiRoot) return
            replacedInferenceRuntime = true
            return inferenceRuntimeModule
          },
          load(id) {
            if (id !== inferenceRuntimeModule) return
            return `export function createInferenceRuntime() {
              throw new Error("The inference runtime is not used by this GUI registration test")
            }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "models-panel-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })

    const { gui, ...host } = await import(
      pathToFileURL(`${outputDirectory}/models-panel-dom-test.js`).href
    )
    expect(replacedInferenceRuntime).toBe(true)

    assignmentAuthorityDirectory = mkdtempSync(join(tmpdir(), "lazers-models-panel-settings-"))
    assignmentAuthorityRepository = new TaskRepository(
      join(assignmentAuthorityDirectory, "tasks.sqlite"),
      DIRECTORY_A,
    )
    const authorityTask = taskDetail(TASK_A, PROJECT_A, DIRECTORY_A, "LZ-17", "Objective A")
    if (authorityTask.status !== "found")
      throw new Error("Expected task fixture for settings authority")
    assignmentAuthorityRepository.insert(authorityTask.task)
    const settingsAuthority = new ModelSettingsService(assignmentAuthorityRepository)
    settingsAuthority.configure({
      target: { scope: "project" },
      persona: "ui",
      expectedRevision: 0,
      route: { providerID: "openai", id: "project-ui-route" },
    })
    settingsAuthority.configure({
      target: { scope: "task", taskID: TASK_A },
      persona: "ui",
      expectedRevision: 0,
      route: { providerID: "openai", id: "route-1" },
    })

    const modelTools = new Map<string, RegisteredModelTool>()
    const modelToolEditor: ToolEditor = {
      add: (tool) => modelTools.set(tool.name, tool),
      list: () => [],
      get: () => undefined,
      namespace: () => {},
      update: () => {},
      remove: () => {},
    }
    const modelToolRegistrationContext = {
      permission: { assert: () => Effect.void },
      tool: {
        transform: (callback: (editor: ToolEditor) => void) =>
          Effect.sync(() => {
            callback(modelToolEditor)
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Pick<Plugin.Context, "tool" | "permission">
    await Effect.runPromise(
      Effect.scoped(
        registerModelTools(modelToolRegistrationContext, assignmentAuthorityRepository),
      ),
    )
    const modelSettingsTool = modelTools.get("lz-get-model-settings")
    if (!modelSettingsTool) throw new Error("Model settings tool was not registered")

    const calls: Array<{
      directory: string
      service: string
      method: string
      input: unknown
      signal?: AbortSignal
    }> = []
    const nativePickerCalls: NativePickerOptions[] = []
    let nextNativePickerSelection: string | undefined
    let pendingNativePickerSelection: Deferred<string | undefined> | undefined
    const pendingNativeCatalogA = deferred<typeof nativeModelCatalog>()
    const counts = new Map<string, number>()
    const sourceSignals = new Map<string, AbortSignal[]>()
    const locationSignals = new Map<string, AbortSignal[]>()
    const comparisonCounts = new Map<string, number>()
    const decisionSnapshotCounts = new Map<string, number>()
    const decisionSnapshots = new Map<string, string>()
    const decisionDeltas = new Map<string, number>()
    let failNextComparison = false
    let suspendedInspection:
      | {
          configurationID: string
          pending: Deferred<ModelDecisionInspect>
          output?: ModelDecisionInspect
        }
      | undefined
    const deferredA1 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredA3 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredB2 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredLocationA2 = deferred<PanelLocation>()
    const deferredLocationA3 = deferred<PanelLocation>()
    const deferredLocationA4 = deferred<PanelLocation>()
    const deferredLocationB1 = deferred<PanelLocation>()
    const opened: unknown[][] = []
    const settingsOpened: unknown[][] = []
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const modelStore = host.createReactiveStore({
      projects: {
        [DIRECTORY_A]: {
          tab: "compare",
          persona: "ui",
          taskKind: null,
          selectedTaskID: TASK_A,
          selectedCandidateID: CANDIDATE_C,
          selectedConfigurationID: CONFIG_ONE,
          split: 56,
          open: true,
          topScroll: 0,
          inspectorScroll: 0,
        },
        [DIRECTORY_B]: {
          tab: "compare",
          persona: "ui",
          taskKind: null,
          selectedTaskID: null,
          selectedCandidateID: null,
          selectedConfigurationID: null,
          split: 64,
          open: true,
          topScroll: 0,
          inspectorScroll: 0,
        },
      },
    })
    const trajectoryStore = host.createReactiveStore({ projects: {} as Record<string, unknown> })

    const record = (
      directory: string,
      service: string,
      method: string,
      input: unknown,
      signal?: AbortSignal,
    ) => calls.push({ directory, service, method, input, signal })
    const nextCount = (key: string) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return count
    }
    const connectionRPCs = [
      // The catalog is read to exhaustion in the background: the first page and one more.
      { service: "lazers.models", method: "comparison", count: 3 },
      { service: "lazers.models", method: "refreshSources", count: 1 },
      { service: "lazers.models", method: "settings", count: 1 },
      { service: "lazers.tasks", method: "query", count: 1 },
      { service: "lazers.tasks", method: "get", count: 1 },
      { service: "lazers.observability", method: "trajectoryStatus", count: 1 },
    ] as const
    const connectionCounts = (directory: string) =>
      connectionRPCs.map(
        ({ service, method }) =>
          calls.filter(
            (call) =>
              call.directory === directory && call.service === service && call.method === method,
          ).length,
      )
    // The comparison is read once or twice by the connection and once more per page, in an order
    // that depends on timing; the other reads happen exactly once.
    const connectedOnceSince = (directory: string, before: number[]) =>
      connectionRPCs.every((request, index) => {
        const delta = connectionCounts(directory)[index]! - before[index]!
        return request.method === "comparison"
          ? delta >= 2 && delta <= request.count
          : delta === request.count
      })
    const locationResult = (directory: string): PanelLocation => ({
      project: {
        canonical: directory,
        id: directory === DIRECTORY_A ? PROJECT_A : PROJECT_B,
      },
    })
    const decisionKey = (directory: string, filters: ModelDecisionFilters) =>
      `${directory}:${JSON.stringify(filters)}`
    const decisionSnapshot = (directory: string, filters: ModelDecisionFilters) =>
      decisionSnapshots.get(decisionKey(directory, filters)) ?? "decision:missing-overview"
    const decisionContext = (
      directory: string,
      filters: ModelDecisionFilters,
      snapshotID: string,
      revision = 0,
    ) => decisionContextFor(filters, directory, snapshotID, revision)
    const decisionConfigs = new Map<string, ModelDecisionConfiguration>([
      [CONFIG_ONE, highConfiguration],
      [lowConfiguration.configurationID, lowConfiguration],
      [CONFIG_SINGLE, qwenConfiguration],
      [CONFIG_ZERO, zeroConfiguration],
      [CONFIG_CROSS_ROUTE, crossRouteConfiguration],
      [unknownPriceConfiguration.configurationID, unknownPriceConfiguration],
    ])
    const decisionRowsByID = new Map<string, ModelDecisionRow>([
      [CONFIG_ONE, highDecisionRow],
      [lowConfiguration.configurationID, lowDecisionRow],
      [CONFIG_SINGLE, qwenDecisionRow],
      [CONFIG_ZERO, zeroDecisionRow],
      [CONFIG_CROSS_ROUTE, crossRouteDecisionRow],
      [unknownPriceConfiguration.configurationID, unknownPriceDecisionRow],
    ])
    const deltaForSnapshot = (snapshotID: string) => decisionDeltas.get(snapshotID) ?? 0
    const decisionRowForSnapshot = (configurationID: string, snapshotID: string) => {
      const row = decisionRowsByID.get(configurationID) ?? highDecisionRow
      return configurationID === CONFIG_CROSS_ROUTE
        ? row
        : shiftDecisionRow(row, deltaForSnapshot(snapshotID))
    }
    const client = {
      location: {
        get: async (
          input: { location: { directory: string } },
          options: { signal: AbortSignal },
        ) => {
          const directory = input.location.directory
          record(directory, "location", "get", input, options.signal)
          const count = nextCount(`${directory}:location`)
          const observed = locationSignals.get(directory) ?? []
          observed.push(options.signal)
          locationSignals.set(directory, observed)
          if (directory === DIRECTORY_A && count === 2) return deferredLocationA2.promise
          if (directory === DIRECTORY_A && count === 3) return deferredLocationA3.promise
          if (directory === DIRECTORY_A && count === 4) return deferredLocationA4.promise
          if (directory === DIRECTORY_B && count === 1) return deferredLocationB1.promise
          return locationResult(directory)
        },
      },
      rpc(definition: { id: string }) {
        if (definition.id === "lazers.models")
          return {
            comparison: async (
              input: { sessionID: string; limit: number; cursor?: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const key = `${directory}:comparison`
              const count = nextCount(key)
              comparisonCounts.set(directory, (comparisonCounts.get(directory) ?? 0) + 1)
              record(directory, "lazers.models", "comparison", input, options.signal)
              if (directory === DIRECTORY_A && failNextComparison) {
                failNextComparison = false
                throw new Error("comparison request unavailable")
              }
              const projectID = directory === DIRECTORY_A ? PROJECT_A : PROJECT_B
              return comparison(projectID, count > 1 ? 2 : 1, input.cursor)
            },
            refreshSources: async (
              input: { sessionID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const key = `${directory}:refreshSources`
              const count = nextCount(key)
              record(directory, "lazers.models", "refreshSources", input, options.signal)
              const observed = sourceSignals.get(directory) ?? []
              observed.push(options.signal)
              sourceSignals.set(directory, observed)
              if (directory === DIRECTORY_A && count === 1) return deferredA1.promise
              if (directory === DIRECTORY_A && count === 3) return deferredA3.promise
              if (directory === DIRECTORY_A && count === 7)
                throw new Error("source request unavailable")
              if (directory === DIRECTORY_B && count === 2) return deferredB2.promise
              return sourceEvidence()
            },
            settings: async (
              input: { sessionID: string; taskID?: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:settings`)
              record(directory, "lazers.models", "settings", input, options.signal)
              return directory === DIRECTORY_A
                ? settingsAuthority.settings({ taskID: input.taskID })
                : settings(directory, input.taskID, count)
            },
            catalog: async (
              input: { sessionID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const requestNumber = nextCount(`${directory}:catalog`)
              record(directory, "lazers.models", "catalog", input, options.signal)
              if (directory === DIRECTORY_A && requestNumber === 1)
                return pendingNativeCatalogA.promise
              if (directory === DIRECTORY_B) throw new Error("catalog offline for project B")
              return nativeModelCatalog
            },
            configure: async (
              input: {
                sessionID: string
                target: ModelMappingUpdate["target"]
                persona: ModelMappingUpdate["persona"]
                expectedRevision: number
                route: ModelMappingUpdate["route"]
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(directory, "lazers.models", "configure", input, options.signal)
              if (directory !== DIRECTORY_A)
                return {
                  status: "conflict" as const,
                  expectedRevision: input.expectedRevision,
                  currentRevision: 0,
                  current: null,
                }
              return settingsAuthority.configure({
                target: input.target,
                persona: input.persona,
                expectedRevision: input.expectedRevision,
                route: input.route,
              })
            },
          }
        if (definition.id === "lazers.models.decision.v2")
          return {
            overview: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const key = decisionKey(directory, input.filters)
              const revision = (decisionSnapshotCounts.get(key) ?? 0) + 1
              decisionSnapshotCounts.set(key, revision)
              const snapshotID = `decision:${directory}:${revision}:${input.filters.persona ?? "all"}:${input.filters.taskKind ?? "all"}`
              decisionSnapshots.set(key, snapshotID)
              const delta = decisionPointDelta(revision, input.filters)
              decisionDeltas.set(snapshotID, delta)
              record(directory, "lazers.models.decision.v2", "overview", input, options.signal)
              const base = fixtureDecisionOverview()
              const noComparablePoints = input.filters.taskKind === "maintenance"
              const points = noComparablePoints
                ? []
                : base.graph.points.flatMap((point) => {
                    const row = decisionRowForSnapshot(point.configurationID, snapshotID)
                    const tokens = row.efficiency.tokensPerAcceptedTask
                    const cost = row.efficiency.currentMarketUSDPerAcceptedTask
                    if (tokens === null || cost === null) return []
                    return {
                      ...point,
                      label: row.configuration.label,
                      tokensPerAcceptedTask: tokens,
                      currentMarketUSDPerAcceptedTask: cost,
                      observationCount: row.efficiency.observationCount,
                      acceptedTaskCount: row.cohort.acceptedTaskCount,
                    }
                  })
              if (!noComparablePoints)
                points.push({
                  configurationID: CONFIG_CROSS_ROUTE,
                  groupID: crossRouteConfiguration.groupID,
                  label: crossRouteConfiguration.label,
                  tokensPerAcceptedTask: 50,
                  currentMarketUSDPerAcceptedTask: 0.00005,
                  observationCount: 1,
                  acceptedTaskCount: 1,
                  partial: false,
                })
              const referenceEstimates = noComparablePoints
                ? [
                    {
                      configurationID: unknownPriceConfiguration.configurationID,
                      label: "Unknown route · OpenRouter subtotal",
                      tokensPerAcceptedTask: 31_250,
                      estimate: unknownReferenceEstimate,
                    },
                  ]
                : [
                    {
                      configurationID: CONFIG_ONE,
                      label: "Producer snapshot GPT-6 high",
                      tokensPerAcceptedTask: decisionRowForSnapshot(CONFIG_ONE, snapshotID)
                        .efficiency.tokensPerAcceptedTask,
                      estimate: highReferenceEstimate,
                    },
                    {
                      configurationID: lowConfiguration.configurationID,
                      label: lowConfiguration.label,
                      tokensPerAcceptedTask: decisionRowForSnapshot(
                        lowConfiguration.configurationID,
                        snapshotID,
                      ).efficiency.tokensPerAcceptedTask,
                      estimate: lowReferenceEstimate,
                    },
                    {
                      configurationID: unknownPriceConfiguration.configurationID,
                      label: "Unknown route · OpenRouter subtotal",
                      tokensPerAcceptedTask: 31_250,
                      estimate: unknownReferenceEstimate,
                    },
                    {
                      configurationID: CONFIG_SINGLE,
                      label: "Qwen reference · coordinate unknown",
                      tokensPerAcceptedTask: null,
                      estimate: qwenReferenceEstimate,
                    },
                    {
                      configurationID: CONFIG_CROSS_ROUTE,
                      estimate: openRouterReference(crossRouteConfiguration.route, "exact", 1),
                    },
                    {
                      configurationID: longReferenceConfigurationID,
                      label: "Misleading row-independent producer alias",
                      tokensPerAcceptedTask: 32_000,
                      estimate: longReferenceEstimate,
                    },
                    {
                      configurationID: sharedNameNullConfigurationID,
                      tokensPerAcceptedTask: 28_000,
                      estimate: sharedNameNullEstimate,
                    },
                    {
                      configurationID: sharedNameVariantConfigurationID,
                      tokensPerAcceptedTask: 30_000,
                      estimate: sharedNameVariantEstimate,
                    },
                    {
                      configurationID: sharedNameOtherModelConfigurationID,
                      tokensPerAcceptedTask: 32_000,
                      estimate: sharedNameOtherModelEstimate,
                    },
                  ]
              return ModelDecisionOverviewOutputSchema.parse({
                context: decisionContext(directory, input.filters, snapshotID, revision),
                graph: {
                  scope: "global-filtered-snapshot",
                  points,
                  frontierConfigurationIDs: noComparablePoints
                    ? []
                    : [
                        ...base.graph.frontierConfigurationIDs.filter((configurationID) =>
                          points.some((point) => point.configurationID === configurationID),
                        ),
                        CONFIG_CROSS_ROUTE,
                      ],
                  referenceEstimates,
                },
                configurationCount: noComparablePoints ? 1 : decisionConfigs.size,
                groupCount: noComparablePoints ? 1 : 4,
              })
            },
            rows: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
                cursor?: string
                limit: number
                snapshotID?: string
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(directory, "lazers.models.decision.v2", "rows", input, options.signal)
              const snapshotID = input.snapshotID ?? decisionSnapshot(directory, input.filters)
              const noPriceCase = input.filters.taskKind === "maintenance"
              const pageRows = noPriceCase
                ? [unknownPriceDecisionRow]
                : input.cursor
                  ? [
                      qwenDecisionRow,
                      zeroDecisionRow,
                      crossRouteDecisionRow,
                      unknownPriceDecisionRow,
                    ]
                  : [highDecisionRow, lowDecisionRow]
              return ModelDecisionRowsOutputSchema.parse({
                context: decisionContext(directory, input.filters, snapshotID),
                rows: pageRows.map((row) =>
                  decisionRowForSnapshot(row.configuration.configurationID, snapshotID),
                ),
                totalCount: noPriceCase ? 1 : decisionConfigs.size,
                nextCursor: noPriceCase || input.cursor ? null : "rows-next",
              })
            },
            configurations: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
                cursor?: string
                limit: number
                snapshotID?: string
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(
                directory,
                "lazers.models.decision.v2",
                "configurations",
                input,
                options.signal,
              )
              const snapshotID = input.snapshotID ?? decisionSnapshot(directory, input.filters)
              const noPriceCase = input.filters.taskKind === "maintenance"
              return ModelDecisionConfigurationsOutputSchema.parse({
                context: decisionContext(directory, input.filters, snapshotID),
                configurations: noPriceCase
                  ? [unknownPriceConfiguration]
                  : input.cursor
                    ? [
                        qwenConfiguration,
                        zeroConfiguration,
                        {
                          ...crossRouteConfiguration,
                          label: "Misleading paged cross-route label",
                        },
                        unknownPriceConfiguration,
                      ]
                    : [highConfiguration, lowConfiguration],
                totalCount: noPriceCase ? 1 : decisionConfigs.size,
                nextCursor: noPriceCase || input.cursor ? null : "configurations-next",
              })
            },
            inspect: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
                snapshotID: string
                configurationID: string
                selectedTaskID: string | null
                contributorCursor?: string
                contributorLimit: number
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(directory, "lazers.models.decision.v2", "inspect", input, options.signal)
              const configuration = decisionConfigs.get(input.configurationID) ?? {
                ...highConfiguration,
                configurationID: input.configurationID,
                label: "Off-page configuration",
              }
              const row = decisionRowForSnapshot(input.configurationID, input.snapshotID)
              const isUnknownReference =
                input.configurationID === unknownPriceConfiguration.configurationID
              const isGlobalHigh = input.configurationID === CONFIG_ONE
              const inspectionConfiguration = isUnknownReference
                ? { ...configuration, label: "Misleading inspected model label · high" }
                : isGlobalHigh
                  ? { ...configuration, label: "Misleading inspected GPT-6 label" }
                  : input.configurationID === CONFIG_CROSS_ROUTE
                    ? { ...configuration, label: "Misleading inspected cross-route label" }
                    : configuration
              const inspectionEfficiency = isUnknownReference
                ? { ...row.efficiency, tokensPerAcceptedTask: 88_888 }
                : isGlobalHigh
                  ? { ...row.efficiency, tokensPerAcceptedTask: 98_765 }
                  : row.efficiency
              const template = fixtureDecisionInspect()
              if (template.status !== "found") throw new Error("Expected fixture inspection")
              const contributor = template.contributorPage.contributors[0]!
              const defaultContributor =
                input.configurationID === CONFIG_SINGLE
                  ? { ...contributor, route: null }
                  : input.configurationID === lowConfiguration.configurationID
                    ? {
                        ...contributor,
                        route: lowConfiguration.route,
                        membership: "cohort-effort" as const,
                      }
                    : contributor
              const isCrossRoute = input.configurationID === CONFIG_CROSS_ROUTE
              const estimate: ModelDecisionEstimate = isCrossRoute
                ? crossRouteEstimate
                : input.configurationID === CONFIG_ZERO
                  ? {
                      status: "zero-accepted" as const,
                      basis: "no-successful-task-efficiency" as const,
                      observationCount: 7,
                      range: { tokens: null, currentMarketUSD: null },
                      confidenceInterval: null,
                    }
                  : input.configurationID === CONFIG_SINGLE
                    ? singleEstimate
                    : isUnknownReference
                      ? {
                          ...ModelDecisionEstimateSchema.parse({
                            ...template.estimate,
                            status: "partial",
                            range: { ...template.estimate.range, currentMarketUSD: null },
                            missing: ["current-price"],
                          }),
                        }
                      : template.estimate
              const historyScope =
                input.configurationID === CONFIG_ONE
                  ? {
                      completeness: "complete-accepted-logical-task-retry-history" as const,
                      routeScope: "same-route" as const,
                    }
                  : input.configurationID === lowConfiguration.configurationID
                    ? {
                        completeness: "complete-accepted-logical-task-retry-history" as const,
                        routeScope: "mixed" as const,
                      }
                    : input.configurationID === CONFIG_SINGLE ||
                        input.configurationID === CONFIG_ZERO
                      ? null
                      : undefined
              const output = ModelDecisionInspectOutputSchema.parse({
                ...template,
                context: decisionContext(
                  directory,
                  input.filters,
                  input.snapshotID,
                  decisionSnapshotCounts.get(decisionKey(directory, input.filters)) ?? 0,
                ),
                configuration: inspectionConfiguration,
                cohort: row.cohort,
                efficiency: inspectionEfficiency,
                nativeReportedCost: row.nativeReportedCost,
                referenceEstimate: row.referenceEstimate,
                selectedTaskID: input.selectedTaskID,
                estimate: isCrossRoute
                  ? input.contributorCursor
                    ? { ...crossRouteEstimate, historyScope: undefined }
                    : crossRouteEstimate
                  : shiftEstimate(
                      { ...estimate, historyScope },
                      deltaForSnapshot(input.snapshotID),
                    ),
                contributorPage: isCrossRoute
                  ? {
                      contributors: [
                        input.contributorCursor ? crossRouteBContributor : crossRouteAContributor,
                      ],
                      totalCount: 2,
                      nextCursor: input.contributorCursor ? null : "contributors-cross-route-next",
                    }
                  : input.contributorCursor
                    ? {
                        contributors: [
                          {
                            ...defaultContributor,
                            taskID: TASK_A,
                            taskReference: "LZ-17",
                            attemptID: null,
                            contribution: "accepted" as const,
                          },
                        ],
                        totalCount: 2,
                        nextCursor: null,
                      }
                    : {
                        contributors: [defaultContributor],
                        totalCount: 2,
                        nextCursor: "contributors-next",
                      },
                ...(input.configurationID === CONFIG_ONE
                  ? {
                      knownUsageMarket: knownUsageMarketForSource(
                        inspectionConfiguration.route,
                        "openrouter-models",
                      ),
                    }
                  : input.configurationID === lowConfiguration.configurationID
                    ? {
                        knownUsageMarket: knownUsageMarketForSource(
                          inspectionConfiguration.route,
                          "native-catalog",
                        ),
                      }
                    : input.configurationID === CONFIG_SINGLE
                      ? {
                          knownUsageMarket: knownUsageMarketForSource(
                            inspectionConfiguration.route,
                            "openrouter-endpoints",
                          ),
                        }
                      : {}),
              })
              if (suspendedInspection?.configurationID === input.configurationID) {
                suspendedInspection.output = output
                return suspendedInspection.pending.promise
              }
              return output
            },
          }
        if (definition.id === "lazers.tasks")
          return {
            query: async (
              input: {
                state: string
                includeCompleted: boolean
                includeRetired: boolean
                limit: number
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:queryTasks`)
              record(directory, "lazers.tasks", "query", input, options.signal)
              return directory === DIRECTORY_A
                ? taskPage(
                    directory,
                    TASK_A,
                    "LZ-17",
                    count > 1 ? "Objective A refreshed" : "Objective A initial",
                    "ses-models-panel",
                  )
                : taskPage(
                    directory,
                    TASK_B,
                    "LZ-42",
                    "Objective B project only",
                    "ses-models-panel",
                  )
            },
            get: async (
              input: { taskID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:getTask`)
              record(directory, "lazers.tasks", "get", input, options.signal)
              return directory === DIRECTORY_A
                ? taskDetail(
                    TASK_A,
                    PROJECT_A,
                    directory,
                    "LZ-17",
                    count > 1 ? "Objective A refreshed" : "Objective A initial",
                  )
                : taskDetail(TASK_B, PROJECT_B, directory, "LZ-42", "Objective B project only")
            },
          }
        if (definition.id === "lazers.observability")
          return {
            trajectoryStatus: async (
              input: { scope: { kind: "project"; sessionID: string }; taskID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:trajectoryStatus`)
              record(directory, "lazers.observability", "trajectoryStatus", input, options.signal)
              return trajectory(
                directory === DIRECTORY_A ? PROJECT_A : PROJECT_B,
                input.taskID,
                count > 1 ? 42 : 10,
              )
            },
          }
        throw new Error(`Unexpected RPC contract ${definition.id}`)
      },
    }

    const sessionScope = host.createReactiveStore({
      id: "ses-models-panel",
      directory: DIRECTORY_A,
      activity: 0,
    })
    const sessionA = {
      get id() {
        return sessionScope.value.id
      },
      get location() {
        return { directory: sessionScope.value.directory }
      },
      get directory() {
        return sessionScope.value.directory
      },
      server: { id: "server-models", connected: true, client },
    }
    const sessionB = {
      id: "ses-models-panel",
      location: { directory: DIRECTORY_B },
      directory: DIRECTORY_B,
      server: sessionA.server,
    }
    const sessions = [sessionA, sessionB]
    const appearanceStore = host.createReactiveStore({
      mode: "dark" as "dark" | "light",
      font: "monospace",
    })
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: host.createTestUI(),
      dialogs: {
        select: async <T>(options: {
          title: string
          placeholder?: string
          current?: T
          options: readonly {
            title: string
            value: T
            description?: string
            group?: string
          }[]
        }) => {
          nativePickerCalls.push(options as unknown as NativePickerOptions)
          if (pendingNativePickerSelection) {
            const pending = pendingNativePickerSelection
            pendingNativePickerSelection = undefined
            return (await pending.promise) as T | undefined
          }
          const choice = nextNativePickerSelection
          nextNativePickerSelection = undefined
          return choice as T | undefined
        },
      },
      appearance: {
        mode: () => appearanceStore.value.mode,
        font: (_kind: "mono") => appearanceStore.value.font,
      },
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => sessionA, list: () => sessions },
      layout: {
        open: (...args: unknown[]) => opened.push(args),
        settings: (...args: unknown[]) => settingsOpened.push(args),
      },
      stores: {
        modelsView: () => modelStore,
        trajectoryView: () => trajectoryStore,
      },
    }

    disposeSetup = host.setupGui(gui, context)
    const tokens = host.registryTokens
    const panel = host.modelPanelRegistration(registrations)
    const panels = registrations
      .filter((entry) => entry.token === tokens.Panel)
      .map(
        (entry) =>
          entry.value as {
            id: string
            list: (input: { open: string[] }) => unknown[]
            render: unknown
          },
      )
    expect(Object.keys(gui.stores)).toContain("modelsView")
    expect(Object.keys(gui.stores)).toContain("trajectoryView")
    expect(panel?.id).toBe("models")
    expect(panels.map((registeredPanel) => registeredPanel.id).toSorted()).toEqual([
      "models",
      "radar",
      "tasks",
      "trajectory",
    ])
    for (const [id, title] of [
      ["radar", "Radar"],
      ["models", "Models"],
      ["trajectory", "Trajectory"],
    ] as const) {
      const registeredPanel = panels.find((entry) => entry.id === id)!
      expect(registeredPanel.list({ open: [] })).toEqual([])
      expect(registeredPanel.list({ open: [id] })).toMatchObject([{ id, title, closable: "hover" }])
      expect(typeof registeredPanel.render).toBe("function")
    }

    const modelCss = registrations.find(
      (entry) =>
        entry.token === tokens.Style &&
        typeof entry.value === "string" &&
        entry.value.includes(".lazers-models {"),
    )?.value as string | undefined
    if (!modelCss) throw new Error("Models panel CSS was not registered")
    expect(modelCss).toContain("container-name: models-panel")
    expect(modelCss).toContain("@container models-panel (min-width: 720px)")
    expect(modelCss).toContain("@container models-panel (max-width: 500px)")
    expect(modelCss).toContain("grid-template-rows: minmax(0, 1fr)")
    expect(modelCss).not.toContain("--models-top-size")
    expect(modelCss).not.toContain("minmax(180px")
    expect(modelCss).not.toContain("minmax(150px")
    expect(modelCss).toContain("min-height: 0")
    expect(modelCss).toContain("overflow: auto")
    expect(modelCss).not.toContain(".lazers-models-separator")
    expect(modelCss).not.toContain(".lazers-models-decision-rows")
    expect(modelCss).not.toContain(".lazers-models-candidates")
    expect(modelCss).not.toContain("border-right: 1px solid var(--border-weak-base)")
    const overviewRule = modelCss.match(/\.lazers-models-overview\s*\{([^}]+)\}/)?.[1] ?? ""
    expect(overviewRule).toContain("grid-template-columns: minmax(0, 1fr)")
    expect(modelCss).not.toContain("@media (min-width: 720px)")
    expect(modelCss).not.toContain("@media (max-width: 500px)")
    expect(modelCss).not.toContain("450px")
    const overviewRules = [...modelCss.matchAll(/\.lazers-models-overview\s*\{([^}]+)\}/g)].map(
      (match) => match[1] ?? "",
    )
    expect(overviewRules).toHaveLength(1)
    expect(overviewRules[0]).toContain("grid-template-columns: minmax(0, 1fr)")
    const style = browserDocument.createElement("style")
    style.textContent = modelCss ?? ""
    browserDocument.head.append(style)

    const command = registrations.find(
      (entry) =>
        entry.token === tokens.Command && (entry.value as { id?: string }).id === "lz-models",
    )?.value as { slash: { name: string }; run: () => void } | undefined
    const menuItem = registrations.find(
      (entry) =>
        entry.token === tokens.MenuItem && (entry.value as { id?: string }).id === "models.open",
    )?.value as { run: () => void } | undefined
    expect(command?.slash).toEqual({ name: "lz-models" })
    command?.run()
    menuItem?.run()
    expect(opened.slice(0, 2)).toEqual([
      ["lazers:models", sessionA, { tab: "select" }],
      ["lazers:models", sessionA, { tab: "select" }],
    ])
    for (const id of ["radar", "trajectory"]) {
      const entries = registrations.filter(
        (entry) =>
          (entry.token === tokens.Command || entry.token === tokens.MenuItem) &&
          (entry.value as { id?: string }).id === `${id}.open`,
      )
      expect(entries).toHaveLength(2)
      entries.forEach((entry) => (entry.value as { run: () => void }).run())
    }
    expect(opened.slice(2, 6)).toEqual([
      ["lazers:radar", sessionA, { tab: "select" }],
      ["lazers:radar", sessionA, { tab: "select" }],
      ["lazers:trajectory", sessionA, { tab: "select" }],
      ["lazers:trajectory", sessionA, { tab: "select" }],
    ])

    const containerA = browserDocument.createElement("main")
    browserDocument.body.append(containerA)
    const mountA = host.mountModelPanel(panel!, context, sessionA, containerA)
    mounts.push(mountA)
    await until(() =>
      calls.some(
        (call) =>
          call.service === "lazers.models" &&
          call.method === "refreshSources" &&
          call.directory === DIRECTORY_A,
      ),
    )
    expect(
      calls.some(
        (call) =>
          call.service === "lazers.models.decision.v2" &&
          call.method === "overview" &&
          call.directory === DIRECTORY_A,
      ),
    ).toBe(false)
    expect(containerA.textContent).toContain("Loading comparison")
    deferredA1.resolve(sourceEvidence())
    await until(
      () => containerA.querySelector(`.lazers-chart [data-point-id="${CONFIG_ONE}"]`) !== null,
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("Objective A initial") === true,
    )
    await until(
      () =>
        containerA.querySelector(".lazers-details-header h2") !== null ||
        containerA.querySelector(".lazers-models-inspector [role=alert]") !== null,
    )
    expect(
      selectedName(containerA) ??
        containerA.querySelector(".lazers-models-inspector [role=alert]")?.textContent,
    ).toBe("GPT-6 refreshed · high")
    const openRouterModelMarketCard = containerA.querySelector<HTMLElement>(
      ".lazers-models-market-scenario",
    )!
    expect(openRouterModelMarketCard.textContent).toContain("OpenRouter model catalog pricing")
    const openRouterModelEvidence = openRouterModelMarketCard.querySelector<HTMLDetailsElement>(
      ".lazers-models-market-evidence-details",
    )!
    openRouterModelEvidence.open = true
    expect(openRouterModelEvidence.textContent).toContain("basis average")
    expect(openRouterModelEvidence.textContent).toContain("OpenRouter model catalog source")
    expect(openRouterModelEvidence.querySelector("a")?.getAttribute("href")).toBe(
      "https://openrouter.ai/api/v1/models",
    )
    openRouterModelEvidence.open = false
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-history-scope")
          ?.textContent?.includes("Route scope · same-route") === true,
    )
    expect(containerA.querySelector(".lazers-models-history-scope")?.closest("details")?.open).toBe(
      false,
    )

    const locationReadsBeforeActivity = calls.filter((call) => call.service === "location").length
    const comparisonDataBeforeActivity = containerA.querySelector(".lazers-models-all-models")
    expect(comparisonDataBeforeActivity).not.toBeNull()
    expect((comparisonDataBeforeActivity as HTMLDetailsElement).open).toBe(false)
    for (let activity = 1; activity <= 3; activity++) {
      sessionScope.update((draft: { activity: number }) => {
        draft.activity = activity
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    expect(calls.filter((call) => call.service === "location")).toHaveLength(
      locationReadsBeforeActivity,
    )
    expect(containerA.querySelector(".lazers-models-all-models")).toBe(comparisonDataBeforeActivity)

    const topPaneA = containerA.querySelector<HTMLElement>(".lazers-models-top")!
    const sourceDetails = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    expect(sourceDetails.open).toBe(false)
    expect(sourceDetails.querySelector("summary")?.textContent).toBe("Sources")
    // The stored split of 56 % for the list leaves 44 % of the panel for the details body.
    expect(
      containerA
        .querySelector<HTMLElement>(".lazers-details")
        ?.style.getPropertyValue("--details-size"),
    ).toBe("0.44")
    expect(sourceDetails.querySelector("summary")?.textContent).not.toContain("snapshots available")
    expect(sourceDetails.querySelector(".lazers-models-source")?.closest("details")).toBe(
      sourceDetails,
    )
    const comparePanel = topPaneA.querySelector<HTMLElement>(".lazers-models-compare")!
    const overview = comparePanel.querySelector<HTMLElement>(".lazers-models-overview")!
    expect(overview.children).toHaveLength(1)
    expect(overview.querySelector(".lazers-models-chart")).not.toBeNull()
    expect(overview.querySelector(".lazers-models-candidates")).toBeNull()
    expect(comparePanel.querySelector(".lazers-models-decision-rows")).toBeNull()
    expect(comparePanel.querySelector("table")).toBeNull()
    expect(overview.compareDocumentPosition(sourceDetails) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    // The plot is an SVG drawn by model-chart.tsx: a group of focusable points.
    // The Compare view is rebuilt when the tab changes, so look the plot up each time.
    const chartRoot = () => containerA.querySelector<HTMLElement>(".lazers-chart")!
    const chartSVG = () => chartRoot().querySelector<SVGSVGElement>("svg.lazers-chart-svg")
    const chartSVGMarkup = () => chartSVG()?.outerHTML ?? ""
    expect(chartSVG()?.getAttribute("role")).toBe("group")
    expect(chartSVG()?.getAttribute("aria-roledescription")).toBe("chart")
    expect(chartSVGMarkup()).toContain("Tokens per accepted task")
    expect(chartSVGMarkup()).toContain("Cost per accepted task")
    const chartPoints = () => [...chartRoot().querySelectorAll<SVGGElement>("[data-point-id]")]
    expect(chartPoints().every((point) => point.getAttribute("role") === "button")).toBe(true)
    // One point is in the tab order; the rest are reached with the arrow keys.
    expect(chartPoints().filter((point) => point.getAttribute("tabindex") === "0")).toHaveLength(1)
    const settleChart = async () => {
      for (let frame = 0; frame < 4; frame++)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return chartSVGMarkup()
    }
    const chartDescription = () =>
      chartPoints()
        .map((point) => point.getAttribute("aria-label"))
        .join(" ")
    const globalGraphDescription = chartDescription()
    expect(globalGraphDescription).toContain("exact route openai / gpt-6 · high")
    const initialAlternative = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-all-models",
    )!
    expect(initialAlternative.open).toBe(false)
    expect(
      initialAlternative.querySelectorAll("button[data-configuration-id]").length,
    ).toBeGreaterThan(1)
    const initialHighChoice = initialAlternative.querySelector<HTMLButtonElement>(
      `[data-configuration-id="${CONFIG_ONE}"]`,
    )!
    expect(initialHighChoice.getAttribute("aria-label")).toContain("GPT-6 refreshed")
    expect(initialHighChoice.getAttribute("aria-pressed")).toBe("true")
    expect(
      chartRoot().querySelector(`[data-point-id="${CONFIG_ONE}"]`)?.getAttribute("aria-pressed"),
    ).toBe("true")
    initialAlternative.open = true
    expect(comparePanel.querySelector(".lazers-models-decision-rows")).toBeNull()
    const selectedInspector = containerA.querySelector<HTMLElement>(".lazers-models-inspector")!
    // The model, route, price and Assign action sit in the pane's sticky header, not the body.
    const selectedHeading = containerA.querySelector<HTMLElement>(".lazers-details-bar")!
    expect(selectedInspector.contains(selectedHeading)).toBe(false)
    expect(selectedHeading.querySelector("h2")?.textContent).toBe("GPT-6 refreshed")
    expect(selectedHeading.querySelector("code")?.textContent).toContain("openai/gpt-6 · high")
    expect(selectedHeading.querySelector("h2")?.getAttribute("aria-label")).toContain(
      "Exact route openai / gpt-6 · high",
    )
    expect(buttonWithText(selectedHeading, "Assign to UI")).toBeDefined()
    const selectedPrice = selectedHeading.querySelector<HTMLElement>(
      ".lazers-models-selected-price",
    )!
    expect(selectedPrice.textContent).toMatch(/^\$[\d.]+ – [\d.]+ per accepted task$/)
    const selectedStats = selectedInspector.querySelector<HTMLElement>(".lazers-models-stats")!
    expect(selectedStats.textContent).toContain("accepted")
    expect(selectedStats.textContent).toContain("tokens / task")
    expect(selectedStats.textContent).toContain("attempts / task")
    expect(selectedStats.textContent).toContain("median time14m")
    // The first view carries no accounting or unknown vocabulary; the detail sits in disclosures.
    const firstView = [selectedHeading, selectedPrice, selectedStats]
      .map((element) => element.textContent)
      .join(" ")
    for (const word of ["unknown", "unavailable", "partial", "subtotal"])
      expect(firstView.toLowerCase()).not.toContain(word)
    const disclosureTitles = [
      ...selectedInspector.querySelectorAll(
        ".lazers-models-disclosure > summary > span:first-child",
      ),
    ].map((title) => title.textContent)
    expect(disclosureTitles).toEqual(
      expect.arrayContaining(["Estimate basis and prices", "Runs with this model", "All models"]),
    )
    expect(
      selectedInspector.querySelectorAll(
        "details.lazers-models-disclosure[open]:not(.lazers-models-all-models)",
      ),
    ).toHaveLength(0)
    const following = Node.DOCUMENT_POSITION_FOLLOWING
    const selectedEvidence = selectedInspector.querySelector<HTMLDetailsElement>(
      ".lazers-models-evidence-details",
    )!
    expect(selectedEvidence.open).toBe(false)
    expect(selectedStats.compareDocumentPosition(selectedEvidence) & following).toBe(following)
    const runsDisclosure = selectedInspector.querySelector<HTMLElement>(
      ".lazers-models-contributor-details",
    )!
    const contributorAction = [
      ...runsDisclosure.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.getAttribute("aria-label") === "Open trajectory for LZ-42")!
    contributorAction.click()
    expect(
      (trajectoryStore.snapshot().projects[DIRECTORY_A] as { target: Record<string, unknown> })
        .target,
    ).toMatchObject({ reference: "LZ-42", projectDirectory: DIRECTORY_A })
    expect(opened.at(-1)).toEqual(["lazers:trajectory", sessionA, { tab: "select" }])
    // The evidence disclosure's open state is saved with the session view.
    selectedEvidence.open = true
    selectedEvidence.dispatchEvent(new Event("toggle"))
    await until(() => modelStore.snapshot().projects[DIRECTORY_A]?.evidenceOpen === true)
    selectedEvidence.open = false
    selectedEvidence.dispatchEvent(new Event("toggle"))
    await until(() => modelStore.snapshot().projects[DIRECTORY_A]?.evidenceOpen === false)
    expect(selectedInspector.scrollTop).toBe(0)
    expect(topPaneA.scrollTop).toBe(0)
    expect(comparePanel.querySelector(".lazers-models-decision-tools")).toBeNull()
    // Variants are separate chart points: no model or effort select, and no task chip, because
    // the first task opens by default for the detail below and is not a filter.
    expect(containerA.querySelector(".lazers-models-selection-tools")).toBeNull()
    expect(containerA.querySelector(".lazers-models-inspector-route")).toBeNull()
    expect(topPaneA.textContent).not.toContain("Refreshing sources")
    expect(topPaneA.querySelector(".lazers-models-task-select")).toBeNull()

    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "execution accepted",
    )
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).not.toContain(
      "LZ-17 · submitted",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)
    const exactReferencePanel = containerA.querySelector<HTMLElement>(
      ".lazers-models-reference-estimate",
    )!
    expect(exactReferencePanel.textContent).toContain("OpenRouter model catalog scalar reference")
    expect(exactReferencePanel.textContent).toContain("$0.0000000000123 / accepted task")
    expect(exactReferencePanel.textContent).toContain("not a common workload")
    expect(exactReferencePanel.textContent).toContain("Denominator · 9 accepted tasks")
    expect(exactReferencePanel.textContent.match(/retrieved/g)).toHaveLength(1)
    expect(exactReferencePanel.closest("details")?.open).toBe(false)
    const exactReferenceDetails = exactReferencePanel.querySelector<HTMLDetailsElement>(
      ".lazers-models-reference-details",
    )!
    expect(exactReferenceDetails.open).toBe(false)
    exactReferenceDetails.open = true
    expect(exactReferenceDetails.textContent).toContain("OpenRouter model catalog source")
    expect(exactReferenceDetails.textContent).toContain("2 failed · 3 retries")
    expect(exactReferenceDetails.textContent).toContain("Cache read")
    exactReferenceDetails.open = false
    expect(
      calls.some(
        (call) =>
          call.service === "lazers.models" &&
          call.method === "comparison" &&
          call.directory === DIRECTORY_A,
      ),
    ).toBe(true)

    const decisionInputs = calls
      .filter((call) => call.service === "lazers.models.decision.v2")
      .map((call) => call.input as { filters?: ModelDecisionFilters })
    expect(decisionInputs.every((input) => input.filters?.persona === "ui")).toBe(true)
    const initialDecisionFilter = decisionInputs[0]!.filters!
    const initialSnapshot = decisionSnapshots.get(decisionKey(DIRECTORY_A, initialDecisionFilter))
    for (const method of ["rows", "configurations"] as const) {
      const firstPageCall = calls.find(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models.decision.v2" &&
          call.method === method &&
          !(call.input as { cursor?: string }).cursor,
      )
      expect(firstPageCall?.input).toMatchObject({ snapshotID: initialSnapshot })
    }

    // "All models": every observed or routed model once, ranked, best trade-off first.
    const initialRows = [
      ...containerA.querySelectorAll<HTMLButtonElement>(
        ".lazers-models-all-models [data-entry-id]",
      ),
    ]
    expect(initialRows.length).toBeGreaterThan(1)
    expect(containerA.querySelector(".lazers-models-all-models summary")?.textContent).toContain(
      "All models",
    )
    expect(containerA.querySelector('[aria-label="Chart mark legend"]')?.textContent).toContain(
      "Other",
    )
    expect(globalGraphDescription).toContain("model-with-long-name")
    expect(globalGraphDescription).toContain("exact route provider-c / model-with-long-name · deep")
    expect(globalGraphDescription).not.toContain("Misleading row-independent producer alias")
    expect(globalGraphDescription).toContain("31,250 actual cohort tokens per accepted task")
    expect(globalGraphDescription).not.toContain("Misleading paged cross-route label")
    expect(globalGraphDescription).not.toContain("Misleading inspected cross-route label")
    expect(
      containerA.querySelector(
        `.lazers-models-all-models [data-configuration-id="${CONFIG_SINGLE}"]`,
      ),
    ).not.toBeNull()
    expect(
      containerA.querySelector(
        `.lazers-models-all-models [data-configuration-id="${CONFIG_ZERO}"]`,
      ),
    ).toBeNull()
    const clickPoint = (configurationID: string) =>
      chartRoot()
        .querySelector(`[data-point-id="${configurationID}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    const pointPressed = (configurationID: string) =>
      chartRoot()
        .querySelector(`[data-point-id="${configurationID}"]`)
        ?.getAttribute("aria-pressed")
    clickPoint(lowConfiguration.configurationID)
    await until(
      () =>
        modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID ===
        lowConfiguration.configurationID,
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-reference-estimate")
          ?.textContent?.includes("OpenRouter model catalog conditional range") === true,
    )
    const nativeMarketCard = containerA.querySelector<HTMLElement>(
      ".lazers-models-market-scenario",
    )!
    expect(nativeMarketCard.textContent).toContain("Native catalog pricing")
    const nativeEvidence = nativeMarketCard.querySelector<HTMLDetailsElement>(
      ".lazers-models-market-evidence-details",
    )!
    nativeEvidence.open = true
    expect(nativeEvidence.textContent).toContain("basis quote")
    expect(nativeEvidence.textContent).toContain("Native model catalog source")
    expect(nativeEvidence.querySelector("a")?.getAttribute("href")).toBe(
      "https://opencode.ai/models",
    )
    nativeEvidence.open = false
    const conditionalInspection = containerA.querySelector<HTMLElement>(
      ".lazers-models-reference-estimate",
    )!
    expect(conditionalInspection.textContent).toContain("$0.00000004–$0.00000012")
    expect(containerA.querySelector(".lazers-models-selected-price")?.textContent).toContain(
      "$0.0838 – 0.204 per accepted task",
    )
    expect(conditionalInspection.textContent).toContain("Denominator · 9 accepted tasks")
    expect(pointPressed(lowConfiguration.configurationID)).toBe("true")

    const beforePointSelectionSVG = chartSVGMarkup()
    clickPoint(CONFIG_SINGLE)
    await until(() => selectedName(containerA) === "qwen-7 · preview-effort")
    const endpointMarketCard = containerA.querySelector<HTMLElement>(
      ".lazers-models-market-scenario",
    )!
    expect(endpointMarketCard.textContent).toContain("OpenRouter endpoint pricing")
    const endpointEvidence = endpointMarketCard.querySelector<HTMLDetailsElement>(
      ".lazers-models-market-evidence-details",
    )!
    endpointEvidence.open = true
    expect(endpointEvidence.textContent).toContain("OpenRouter endpoint source")
    expect(endpointEvidence.querySelector("a")?.getAttribute("href")).toContain(
      "https://openrouter.ai/",
    )
    endpointEvidence.open = false
    await until(() => pointPressed(CONFIG_SINGLE) === "true")
    await until(() => chartSVGMarkup() !== beforePointSelectionSVG)
    const selectedQwenGraphSVG = await settleChart()
    expect(selectedQwenGraphSVG).toContain("qwen-7")
    expect(selectedQwenGraphSVG).toContain("preview-effort")
    const currentFilters = (
      calls.filter((call) => call.method === "overview").at(-1)?.input as {
        filters: ModelDecisionFilters
      }
    ).filters
    const currentSnapshotID = decisionSnapshots.get(decisionKey(DIRECTORY_A, currentFilters))
    await until(() =>
      calls.some((call) => {
        if (call.service !== "lazers.models.decision.v2" || call.method !== "inspect") return false
        return (
          (
            call.input as {
              configurationID?: string
              selectedTaskID?: string | null
              snapshotID?: string
            }
          ).configurationID === CONFIG_SINGLE &&
          (call.input as { selectedTaskID?: string | null }).selectedTaskID === TASK_A &&
          (call.input as { snapshotID?: string }).snapshotID === currentSnapshotID
        )
      }),
    )
    for (const method of ["overview", "rows", "configurations", "inspect"])
      expect(
        calls.some(
          (call) =>
            call.directory === DIRECTORY_A &&
            call.service === "lazers.models.decision.v2" &&
            call.method === method,
        ),
      ).toBe(true)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_SINGLE)
    expect(pointPressed(CONFIG_SINGLE)).toBe("true")
    const qwenInspectionInput = calls
      .filter((call) => call.method === "inspect")
      .map(
        (call) =>
          call.input as {
            configurationID?: string
            selectedTaskID?: string | null
            snapshotID?: string
          },
      )
      .find(
        (input) =>
          input.configurationID === CONFIG_SINGLE && input.snapshotID === currentSnapshotID,
      )
    expect(qwenInspectionInput).toMatchObject({
      configurationID: CONFIG_SINGLE,
      selectedTaskID: TASK_A,
      snapshotID: currentSnapshotID,
    })
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector .lazers-models-estimate")
          ?.textContent?.includes("n=1") === true,
    )
    expect(
      containerA.querySelector(".lazers-models-inspector .lazers-models-estimate")?.textContent,
    ).toContain("one value, no interval")
    const routeEvidence = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-inspector .lazers-models-evidence-details",
    )!
    expect(routeEvidence.open).toBe(false)
    const unknownHistoryLabel =
      routeEvidence.querySelector(".lazers-models-history-scope")?.textContent ?? ""
    // No history scope from the producer: the row is omitted rather than labelled.
    expect(unknownHistoryLabel).toBe("")
    routeEvidence.open = true
    routeEvidence.dispatchEvent(new Event("toggle"))
    expect(routeEvidence.textContent).toContain("Accepted-task retry history may be incomplete")
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "Current price",
    )
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "native-reported",
    )
    expect(routeEvidence.textContent).toContain("Exact route")
    expect(routeEvidence.textContent).toContain("Native reported charges")
    expect(routeEvidence.open).toBe(true)
    const unknownContributorDetails = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-contributor-details",
    )!
    unknownContributorDetails.open = true
    const unknownContributorMetadata =
      containerA.querySelector(".lazers-models-contributor")?.textContent ?? ""
    // A contributor with no recorded route or membership shows neither row.
    expect(unknownContributorMetadata).not.toContain("Exact route")
    expect(unknownContributorMetadata).not.toContain("Membership")
    expect(unknownContributorMetadata).not.toMatch(/unknown/i)
    unknownContributorDetails.open = false

    expect(
      containerA.querySelector(
        `.lazers-models-all-models [data-configuration-id="${CONFIG_SINGLE}"]`,
      ),
    ).not.toBeNull()
    // Model rows and exact configurations are not paged by hand any more: no pager is offered.
    expect(containerA.querySelector(".lazers-models-route-pages")).toBeNull()
    expect(buttonWithText(containerA, "Load more model groups")).toBeUndefined()
    expect(buttonWithText(containerA, "Load more exact configurations")).toBeUndefined()
    await settleChart()
    expect(chartDescription()).toBe(globalGraphDescription)
    expect(chartDescription()).toContain("priced subtotal only")
    expect(chartDescription()).toContain("31,250 actual cohort tokens per accepted task")
    const loadedReferenceSVG = chartSVGMarkup()
    const loadedReferenceGraphDescription = chartDescription()

    const firstContributorPage = containerA.querySelector(".lazers-models-contributors")!
    const evidenceDisclosure = firstContributorPage.closest<HTMLDetailsElement>(
      "details.lazers-models-disclosure",
    )!
    evidenceDisclosure.open = true
    const contributorTextBefore = firstContributorPage.textContent
    const moreContributors = buttonWithText(firstContributorPage, "Load more contributors")
    if (!moreContributors) throw new Error("Missing contributor pager")
    moreContributors.click()
    await until(() =>
      calls.some(
        (call) =>
          call.method === "inspect" &&
          Boolean((call.input as { contributorCursor?: string }).contributorCursor),
      ),
    )
    await until(() => firstContributorPage.textContent?.includes("LZ-17") === true)
    expect(chartDescription()).toBe(loadedReferenceGraphDescription)
    expect(chartSVGMarkup()).toBe(loadedReferenceSVG)
    const contributorTrajectory = firstContributorPage.querySelector<HTMLButtonElement>(
      '[aria-label="Open trajectory for LZ-17"]',
    )
    contributorTrajectory?.click()
    const contributorTarget = (
      trajectoryStore.snapshot().projects[DIRECTORY_A] as { target: Record<string, unknown> }
    ).target
    expect(contributorTarget).toMatchObject({
      taskID: TASK_A,
      reference: "LZ-17",
      projectID: PROJECT_A,
      projectDirectory: DIRECTORY_A,
    })
    expect(contributorTextBefore).toContain("LZ-42")

    const unknownReferencePoint = chartRoot().querySelector(
      `[data-point-id="${unknownPriceConfiguration.configurationID}"]`,
    )!
    const unknownLabel = unknownReferencePoint.getAttribute("aria-label")!
    expect(unknownLabel).toContain("model-identity-with-a-very-long-unrecognized-name")
    expect(unknownLabel).toContain(
      "exact route unknown-provider / model-identity-with-a-very-long-unrecognized-name",
    )
    expect(unknownLabel).not.toContain("Unknown route · OpenRouter subtotal")
    expect(unknownLabel).toContain("31,250 actual cohort tokens per accepted task")
    clickPoint(unknownPriceConfiguration.configurationID)
    await until(
      () =>
        modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID ===
        unknownPriceConfiguration.configurationID,
    )
    await until(() => pointPressed(unknownPriceConfiguration.configurationID) === "true")
    const selectedUnknownReferenceSVG = await settleChart()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("88,888 tokens") === true,
    )
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "OpenRouter model catalog priced subtotal only",
    )
    // A priced portion is not a price: the first view omits it and the basis disclosure explains.
    expect(containerA.querySelector(".lazers-models-selected-price")).toBeNull()
    const estimateBasis = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-inspector .lazers-models-evidence-details",
    )!
    estimateBasis.open = true
    expect(estimateBasis.querySelector(".lazers-models-market-basis")?.textContent).toContain(
      "total and remainder unknown",
    )
    expect(estimateBasis.querySelector(".lazers-models-market-basis")?.textContent).toContain(
      "denominator 1 accepted task",
    )
    expect(chartDescription()).toBe(globalGraphDescription)
    expect(chartSVGMarkup()).toBe(selectedUnknownReferenceSVG)

    const highRow = chartRoot().querySelector(`[data-point-id="${CONFIG_ONE}"]`)!
    const pendingHighInspection = deferred<ModelDecisionInspect>()
    const inspectCountBeforeRowSelection = calls.filter(
      (call) => call.service === "lazers.models.decision.v2" && call.method === "inspect",
    ).length
    suspendedInspection = { configurationID: CONFIG_ONE, pending: pendingHighInspection }
    clickPoint(CONFIG_ONE)
    await until(() =>
      calls
        .filter((call) => call.service === "lazers.models.decision.v2" && call.method === "inspect")
        .slice(inspectCountBeforeRowSelection)
        .some((call) => {
          const input = call.input as {
            configurationID?: string
            selectedTaskID?: string | null
            snapshotID?: string
          }
          return (
            input.configurationID === CONFIG_ONE &&
            input.selectedTaskID === TASK_A &&
            input.snapshotID === currentSnapshotID
          )
        }),
    )
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).not.toContain(
      "Loading model details",
    )
    const highSelectionSVG = await settleChart()
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)
    expect(highRow.isConnected).toBe(true)
    expect(highRow.getAttribute("aria-pressed")).toBe("true")
    // The previous inspection stays on screen, dimmed, until the new one arrives.
    expect(
      containerA
        .querySelector(".lazers-models-inspector-compare")
        ?.getAttribute("data-panel-dimmed"),
    ).toBe("true")
    await until(() => suspendedInspection?.output !== undefined)
    pendingHighInspection.resolve(suspendedInspection!.output!)
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("98,765 tokens") === true,
    )
    expect(
      containerA.querySelector(".lazers-models-inspector .lazers-models-estimate")?.textContent,
    ).toContain("n=9")
    expect(containerA.querySelector(".lazers-models-selected-price")?.textContent).toContain(
      "per accepted task",
    )
    expect(chartDescription()).toBe(globalGraphDescription)
    expect(chartSVGMarkup()).toBe(highSelectionSVG)
    expect(highRow.isConnected).toBe(true)
    expect(highRow.getAttribute("aria-pressed")).toBe("true")
    expect(containerA.querySelector(".lazers-models-history-scope")?.textContent).toContain(
      "Route scope · same-route",
    )
    expect(
      containerA.querySelector<HTMLDetailsElement>(
        ".lazers-models-inspector .lazers-models-evidence-details",
      )?.open,
    ).toBe(true)
    suspendedInspection = undefined
    // Efforts and models are separate chart points: choose by the point or its data row.
    const choose = (configurationID: string) => {
      if (!chartRoot().querySelector(`[data-point-id="${configurationID}"]`))
        throw new Error(`No chart point for ${configurationID}`)
      clickPoint(configurationID)
    }
    choose(lowConfiguration.configurationID)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (
      modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID !==
      lowConfiguration.configurationID
    )
      throw new Error(
        `Effort action failed: ${JSON.stringify(modelStore.snapshot().projects[DIRECTORY_A])}`,
      )
    await until(
      () =>
        chartRoot()
          .querySelector('[data-point-id][aria-pressed="true"]')
          ?.getAttribute("data-point-id") === lowConfiguration.configurationID,
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(
      lowConfiguration.configurationID,
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-history-scope")
          ?.textContent?.includes("Route scope · mixed") === true,
    )
    const lowContributorDetails = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-contributor-details",
    )!
    lowContributorDetails.open = true
    const lowContributorMetadata =
      containerA.querySelector(".lazers-models-contributor")?.textContent ?? ""
    expect(lowContributorMetadata).toContain("Exact route · openai / gpt-6 · low")
    expect(lowContributorMetadata).toContain("Membership · cohort-effort")
    expect(calls.filter((call) => call.method === "inspect").at(-1)?.input).toMatchObject({
      configurationID: lowConfiguration.configurationID,
      selectedTaskID: TASK_A,
    })

    choose(CONFIG_SINGLE)
    await until(
      () => modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID === CONFIG_SINGLE,
    )
    expect(selectedName(containerA)).toBe("qwen-7 · preview-effort")
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-selected-price")
          ?.textContent?.includes("per accepted task") === true,
    )
    expect(
      containerA.querySelector(".lazers-models-selected-price")?.closest(".lazers-details-bar"),
    ).not.toBeNull()
    expect(
      containerA.querySelector<HTMLElement>(".lazers-models-evidence-details")?.textContent,
    ).toContain("OpenRouter")
    expect(containerA.querySelector(".lazers-models-inspector")?.scrollTop).toBe(0)

    // A configuration with no accepted task has no price and is not a chart point.
    expect(
      containerA.querySelector(
        `.lazers-models-all-models [data-configuration-id="${CONFIG_ZERO}"]`,
      ),
    ).toBeNull()
    expect(chartDescription()).toBe(loadedReferenceGraphDescription)

    choose(CONFIG_CROSS_ROUTE)
    await until(
      () =>
        modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID === CONFIG_CROSS_ROUTE,
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-history-scope")
          ?.textContent?.includes("Route scope · cross-route") === true,
    )
    const crossRouteEstimateText =
      containerA.querySelector(".lazers-models-inspector .lazers-models-estimate")?.textContent ??
      ""
    expect(crossRouteEstimateText).toContain("n=1 accepted logical-task history")
    expect(crossRouteEstimateText).toContain("one value, no interval")
    expect(crossRouteEstimateText).toContain("150 tokens")
    const crossRouteInspection = containerA.querySelector<HTMLElement>(
      ".lazers-models-decision-inspection",
    )!
    expect(crossRouteInspection.textContent).toContain("Configuration cohort")
    expect(crossRouteInspection.textContent).toContain("1 accepted / 1 terminal logical tasks")
    expect(crossRouteInspection.textContent).toContain("50 tokens")
    expect(crossRouteInspection.textContent).not.toContain("150 tokens")
    const crossRouteEvidence = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-inspector .lazers-models-evidence-details",
    )!
    crossRouteEvidence.open = true
    expect(crossRouteEvidence.textContent).toContain("Complete accepted-task retry history")
    expect(crossRouteEvidence.textContent).toContain(
      "The producer reports complete accepted-task histories, including retries.",
    )
    const crossRouteContributorDetails = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-contributor-details",
    )!
    crossRouteContributorDetails.open = true
    const crossRouteContributors = containerA.querySelector(".lazers-models-contributors")!
    expect(crossRouteContributors.textContent).toContain("provider-a / model-a · 100")
    expect(crossRouteContributors.textContent).toContain("Membership · history-only")
    const crossRouteMore = buttonWithText(crossRouteContributors, "Load more contributors")
    if (!crossRouteMore) throw new Error("Missing the cross-route contributor page")
    crossRouteMore.click()
    await until(
      () => crossRouteContributors.textContent?.includes("provider-b / model-b · 50") === true,
    )
    expect(crossRouteContributors.textContent).toContain("Membership · both")
    expect(containerA.querySelector(".lazers-models-history-scope")?.textContent).toContain(
      "Route scope · cross-route",
    )

    const personaFilter = containerA.querySelectorAll<HTMLButtonElement>(
      ".lazers-models-filters .lazers-models-chip button",
    )[0]!
    personaFilter.click()
    menuItemWithText(containerA, "Systems")?.click()
    await until(
      () =>
        containerA.querySelector(".lazers-models-filters")?.textContent?.includes("Systems") ===
        true,
    )
    await until(
      () =>
        selectedName(containerA) === "Off-page configuration" ||
        calls.some(
          (call) =>
            call.method === "overview" &&
            (call.input as { filters?: ModelDecisionFilters }).filters?.persona === "systems",
        ),
    )
    const systemsOverview = calls.filter((call) => call.method === "overview").at(-1)?.input as {
      filters?: ModelDecisionFilters
    }
    expect(systemsOverview.filters?.persona).toBe("systems")
    const taskKindFilter = containerA.querySelectorAll<HTMLButtonElement>(
      ".lazers-models-filters .lazers-models-chip button",
    )[1]!
    taskKindFilter.click()
    menuItemWithText(containerA, "Testing")?.click()
    await until(
      () =>
        containerA.querySelector(".lazers-models-filters")?.textContent?.includes("Testing") ===
        true,
    )
    await until(() =>
      calls.some(
        (call) =>
          call.method === "overview" &&
          (call.input as { filters?: ModelDecisionFilters }).filters?.taskKind === "testing",
      ),
    )
    expect(
      calls
        .filter(
          (call) => call.service === "lazers.models.decision.v2" && call.method === "overview",
        )
        .at(-1)?.input,
    ).toMatchObject({ filters: { persona: "systems", taskKind: "testing" } })
    taskKindFilter.click()
    menuItemWithText(containerA, "Maintenance")?.click()
    // Fewer than two observed models: the public benchmark leads until the user chooses.
    await until(
      () => containerA.querySelector(".lazers-models-chart h3")?.textContent === "Public benchmark",
    )
    const modeButton = (mode: "observed" | "benchmark") =>
      containerA.querySelector<HTMLButtonElement>(`[data-segment="${mode}"]`)!
    expect(modeButton("benchmark").getAttribute("aria-checked")).toBe("true")
    expect(modeButton("benchmark").closest("[role=radiogroup]")?.getAttribute("aria-label")).toBe(
      "Comparison basis",
    )
    expect(containerA.querySelector(".lazers-chart-caption")?.textContent).toContain(
      "Artificial Analysis Coding Index",
    )
    expect(containerA.querySelector(".lazers-chart-caption")?.textContent).toContain(
      "OpenRouter list price",
    )
    expect(containerA.querySelector(".lazers-models-decision-status")).toBeNull()
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.compareMode ?? null).toBeNull()
    const miniRow = containerA.querySelector<SVGGElement>(
      '.lazers-chart [data-point-id="6:openai|10:gpt-6-mini|-"]',
    )!
    expect(miniRow.getAttribute("aria-label")).toContain("exact route openai / gpt-6-mini")
    expect(containerA.querySelector(".lazers-models-benchmark-coverage")?.textContent).toContain(
      "1 plotted",
    )
    miniRow.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await until(() => selectedName(containerA) === "GPT-6 Mini")
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(
      "6:openai|10:gpt-6-mini|-",
    )
    expect(containerA.querySelector(".lazers-models-selected-price")?.textContent).toBe(
      "$0.7 per 1M tokens",
    )
    expect(containerA.querySelector(".lazers-models-stats")?.textContent).toContain("coding42.5")
    const benchmarkDetails = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-benchmark-details",
    )!
    // Shares the saved details preference with the observed inspector.
    expect(benchmarkDetails.open).toBe(
      modelStore.snapshot().projects[DIRECTORY_A]?.evidenceOpen ?? false,
    )
    expect(benchmarkDetails.textContent).toContain("does not state the effort")
    expect(benchmarkDetails.textContent).toContain("input $0.4 · output $1.6 · cache read $0.1")
    expect(benchmarkDetails.textContent).toContain("A list price is not a task cost")
    const benchmarkActions = containerA.querySelector<HTMLElement>(".lazers-details-bar")!
    const benchmarkAssign = buttonWithText(benchmarkActions, "Assign to Systems")!
    await until(() => !benchmarkAssign.disabled)
    expect(containerA.querySelector(".lazers-models-selection-tools")).toBeNull()
    modeButton("observed").click()
    await until(() => modelStore.snapshot().projects[DIRECTORY_A]?.compareMode === "observed")
    await until(
      () =>
        containerA.querySelector(".lazers-models-chart h3")?.textContent === "Task outcomes" &&
        containerA.querySelector(
          `.lazers-models-all-models [data-configuration-id="${unknownPriceConfiguration.configurationID}"]`,
        ) !== null,
    )
    expect(containerA.querySelector(".lazers-chart svg")).not.toBeNull()
    expect(containerA.querySelector(".lazers-chart-legend")?.textContent).toBe("Other")
    const unknownPricePoint = containerA.querySelector<SVGGElement>(
      `.lazers-chart [data-point-id="${unknownPriceConfiguration.configurationID}"]`,
    )!
    expect(unknownPricePoint.getAttribute("aria-label")).toContain(
      "exact route unknown-provider / model-identity-with-a-very-long-unrecognized-name",
    )
    expect(containerA.querySelector(".lazers-models-selected-price")?.textContent).toContain(
      "$0.00015 per accepted task",
    )
    unknownPricePoint.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await until(
      () =>
        modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID ===
        unknownPriceConfiguration.configurationID,
    )
    await until(() => containerA.querySelector(".lazers-models-reference-estimate") !== null)
    const partialInspection = containerA.querySelector<HTMLElement>(
      ".lazers-models-reference-estimate",
    )!
    expect(partialInspection.textContent).toContain("priced subtotal only")
    expect(partialInspection.textContent).toContain("remainder unknown")
    expect(partialInspection.closest("details")?.open).toBe(true)
    const partialCoverage = partialInspection.querySelector<HTMLDetailsElement>(
      ".lazers-models-reference-details",
    )!
    partialCoverage.open = true
    expect(partialCoverage.textContent).toContain(
      "Cache write · missing usage · missing rate coverage",
    )
    expect(partialCoverage.textContent).toContain("2 failed · 3 retries")
    expect(partialCoverage.textContent).toContain("unknown route")
    expect(partialCoverage.textContent).toContain("not a common workload")
    taskKindFilter.click()
    menuItemWithText(containerA, "All task kinds")?.click()
    await until(() => containerA.querySelector(".lazers-chart") !== null)
    expect(
      calls.some(
        (call) =>
          call.service === "lazers.models" &&
          call.method === "refreshSources" &&
          call.directory === DIRECTORY_A,
      ),
    ).toBe(true)

    await until(
      () =>
        !buttonWithText(containerA, "Refresh")?.disabled && comparisonCounts.get(DIRECTORY_A) === 3,
    )
    const inspectorA = containerA.querySelector<HTMLElement>(".lazers-models-inspector")!
    expect(inspectorA.querySelector(".lazers-models-task-summary")?.textContent).toContain("LZ-17")
    expect(inspectorA.querySelector(".lazers-models-task-summary")?.textContent).toContain(
      "execution accepted",
    )
    const effortDetails = inspectorA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    expect(effortDetails.open).toBe(false)
    expect(effortDetails.querySelector(".lazers-models-category-row")?.closest("details")).toBe(
      effortDetails,
    )
    effortDetails.open = true
    expect(effortDetails.textContent).toContain("tokens")
    expect(effortDetails.textContent).not.toContain("market-equivalent cost")
    effortDetails.open = false

    // The details pane keeps `open` and `size` in the stored view; its header is the collapsed state.
    const separator = containerA.querySelector<HTMLDivElement>('[role="separator"]')!
    const storedView = () =>
      modelStore.snapshot().projects[DIRECTORY_A] as { open?: boolean; size?: number } | undefined
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal")
    expect(separator.getAttribute("aria-valuenow")).toBe("44")
    containerA.querySelector<HTMLElement>(".lazers-details")!.getBoundingClientRect = () =>
      ({ top: 0, height: 500 }) as DOMRect
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(storedView()?.size).toBeCloseTo(0.49)
    expect(separator.getAttribute("aria-valuenow")).toBe("49")
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(storedView()?.size).toBeCloseTo(0.44)
    const headerText = containerA.querySelector(".lazers-details-header")?.textContent
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(storedView()?.open).toBe(false)
    expect(containerA.querySelector(".lazers-models-inspector")).toBeNull()
    expect(containerA.querySelector(".lazers-details-header")?.textContent).toBe(headerText)
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(storedView()?.open).toBe(true)
    expect(containerA.querySelector(".lazers-models-inspector")).not.toBeNull()

    const firstRow = containerA.querySelector<SVGGElement>(
      `.lazers-chart [data-point-id="${CONFIG_ONE}"]`,
    )!
    firstRow.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (firstRow.getAttribute("aria-pressed") !== "true")
      throw new Error(
        `Exact chart data alternative did not select: ${JSON.stringify(modelStore.snapshot().projects[DIRECTORY_A])} · inspector=${selectedName(containerA)} · inspect=${JSON.stringify(
          calls
            .filter((call) => call.method === "inspect")
            .slice(-4)
            .map((call) => call.input),
        )}`,
      )
    const trajectoryButton = buttonWithText(
      containerA.querySelector(".lazers-models-task-summary")!,
      "Open trajectory",
    )
    trajectoryButton?.click()
    const target = (
      trajectoryStore.snapshot().projects[DIRECTORY_A] as { target: Record<string, unknown> }
    ).target
    expect(target).toMatchObject({
      taskID: TASK_A,
      reference: "LZ-17",
      projectID: PROJECT_A,
      projectDirectory: DIRECTORY_A,
    })
    expect(target.requestID).toMatch(/^[0-9a-f-]{36}$/)
    expect(opened.at(-1)).toEqual(["lazers:trajectory", sessionA, { tab: "select" }])

    // "Assign to <persona>" opens the existing editor with the compared route as an unsaved draft.
    const assignAction = buttonWithText(
      containerA.querySelector(".lazers-details-bar")!,
      "Assign to Systems",
    )!
    await until(() => !assignAction.disabled)
    assignAction.click()
    await until(
      () =>
        containerA.querySelector<HTMLInputElement>(
          '.lazers-models-assignment-editor input[aria-label="Model ID"]',
        )?.value === "gpt-6",
    )
    const draftInput = (label: string) =>
      containerA.querySelector<HTMLInputElement>(
        `.lazers-models-assignment-editor input[aria-label="${label}"]`,
      )?.value
    expect(draftInput("Provider ID")).toBe("openai")
    expect(draftInput("Variant / effort (optional)")).toBe("high")
    expect(containerA.querySelector(".lazers-details-header h2")?.textContent).toBe("Systems")
    expect(containerA.querySelector(".lazers-models-assignment-editor")?.textContent).toContain(
      "New workers use this route. Running workers keep theirs.",
    )
    expect(containerA.querySelector(".lazers-models-from-compare")?.textContent).toContain(
      "From Compare:",
    )
    expect(
      calls.filter((call) => call.service === "lazers.models" && call.method === "configure"),
    ).toHaveLength(0)
    const assignmentTab = containerA.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="lazers-models-assignments-panel"]',
    )!
    assignmentTab.click()
    await until(() => containerA.textContent?.includes("route-1") === true)
    // Assignments is its own view: no Compare filters, sources, chart or selected-model pane.
    expect(containerA.querySelector(".lazers-chart")).toBeNull()
    expect(containerA.querySelector(".lazers-models-filters")).toBeNull()
    expect(containerA.querySelector(".lazers-models-sources-details")).toBeNull()
    expect(containerA.querySelector(".lazers-models-inspector-compare")).toBeNull()
    expect(
      containerA
        .querySelector(".lazers-models-assignment-editor")
        ?.closest(".lazers-models-inspector"),
    ).not.toBeNull()
    await until(() =>
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "catalog",
      ),
    )
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "catalog" &&
          JSON.stringify(call.input) === JSON.stringify({ sessionID: sessionA.id }),
      ),
    ).toBe(true)
    expect(
      containerA.querySelector(".lazers-models-top .lazers-models-assignment-editor"),
    ).toBeNull()
    const assignmentRows = () => [
      ...containerA.querySelectorAll<HTMLButtonElement>(".lazers-models-assignment-row"),
    ]
    const rowForPersona = (label: string) =>
      assignmentRows().find((row) => row.querySelector("strong")?.textContent === label)!
    expect(assignmentRows()).toHaveLength(3)
    expect(assignmentRows().map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UI"),
        expect.stringContaining("Systems"),
        expect.stringContaining("Small task / refactoring"),
      ]),
    )
    rowForPersona("UI").click()
    const assignmentEditor = containerA.querySelector<HTMLElement>(
      ".lazers-models-inspector .lazers-models-assignment-editor",
    )!
    expect(assignmentEditor.closest(".lazers-models-inspector")).not.toBeNull()
    expect(
      containerA.querySelectorAll(".lazers-models-top .lazers-models-assignment-editor"),
    ).toHaveLength(0)
    expect(containerA.querySelectorAll(".lazers-models-assignment-editor")).toHaveLength(1)
    expect(containerA.querySelector(".lazers-models-assignments")?.textContent).not.toContain(
      "Routing is not active",
    )
    expect(
      containerA.querySelector(".lazers-models-assignment-rows")?.contains(assignmentEditor),
    ).toBe(false)
    expect(containerA.querySelector("[data-decision-status]")).toBeNull()
    expect(containerA.textContent).not.toContain("Select a model to compare.")
    expect(assignmentEditor.getAttribute("aria-labelledby")).toBe(
      containerA.querySelector(".lazers-details-header h2")!.id,
    )
    expect(rowForPersona("UI").getAttribute("aria-pressed")).toBe("true")
    expect(rowForPersona("Systems").getAttribute("aria-pressed")).toBe("false")
    expect(
      containerA.querySelector(".lazers-models-catalog-status")?.textContent?.includes("Loading"),
    ).toBe(true)
    const manualRouteDetailsWhileLoading = assignmentEditor.querySelector<HTMLDetailsElement>(
      ".lazers-models-assignment-manual-route",
    )!
    manualRouteDetailsWhileLoading.open = true
    expect(
      [...manualRouteDetailsWhileLoading.querySelectorAll<HTMLInputElement>("input")].every(
        (input) => !input.disabled,
      ),
    ).toBe(true)
    expect(buttonWithText(containerA.querySelector(".lazers-details-bar")!, "Save")?.disabled).toBe(
      false,
    )
    expect(
      assignmentEditor.querySelector<HTMLButtonElement>(".lazers-models-assignment-choice > button")
        ?.disabled,
    ).toBe(true)
    manualRouteDetailsWhileLoading.open = false
    pendingNativeCatalogA.resolve(nativeModelCatalog)
    await until(() => containerA.querySelector(".lazers-models-catalog-status") === null)
    const compareTab = containerA.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="lazers-models-compare-panel"]',
    )!
    compareTab.click()
    await until(() => containerA.querySelector(".lazers-details-bar") !== null)
    await until(() =>
      chartDescription().includes("An unusually long catalog-backed model display name"),
    )
    const catalogGraphDescription = chartDescription()
    expect(catalogGraphDescription).toContain("An unusually long catalog-backed model display name")
    expect(catalogGraphDescription).toContain("Qwen 7")
    expect(catalogGraphDescription).toContain("GPT-6 · high · exact route openai / gpt-6 · high")
    expect(catalogGraphDescription).toContain(
      "GPT-6 · provider-b / model-b · 50 · exact route provider-b / model-b · 50",
    )
    expect(catalogGraphDescription).toContain("GPT-6 · exact route provider-a / model-a")
    expect(catalogGraphDescription).toContain(
      "GPT-6 · high · exact route provider-a / model-a · high",
    )
    expect(catalogGraphDescription).toContain("GPT-6 · exact route provider-a / model-c")
    // 50 tokens to 32K is more than a 50x spread: the x axis says it is logarithmic.
    expect(chartRoot().textContent).toContain("Tokens per accepted task · log")
    clickPoint(CONFIG_SINGLE)
    await until(() => selectedName(containerA) === "Qwen 7 · preview-effort")
    expect(
      containerA.querySelector(".lazers-details-header h2")?.getAttribute("aria-label"),
    ).toContain("Exact route qwen / qwen-7 · preview-effort")
    expect(
      containerA.querySelector(".lazers-models-selected-identity code")?.textContent,
    ).toContain("preview-effort")
    const restoreHighSelection = containerA.querySelector<HTMLButtonElement>(
      `.lazers-models-all-models [data-configuration-id="${CONFIG_ONE}"]`,
    )!
    restoreHighSelection.click()
    await until(() => selectedName(containerA)?.startsWith("GPT-6") ?? false)
    expect(
      containerA.querySelector(".lazers-details-header h2")?.getAttribute("aria-label"),
    ).toContain("Exact route openai / gpt-6 · high")
    assignmentTab.click()
    await until(() => containerA.querySelector(".lazers-models-assignment-editor") !== null)
    const assignmentLayers = () =>
      containerA.querySelector<HTMLDetailsElement>(".lazers-models-assignment-layers")!
    expect(assignmentLayers().open).toBe(false)

    const chooseScope = (scope: "shared" | "project" | "task") =>
      containerA
        .querySelector<HTMLButtonElement>(
          `.lazers-models-assignment-editor [data-segment="${scope}"]`,
        )
        ?.click()
    const catalogSelection = JSON.stringify(["openai", "gpt-6"])
    const currentAssignmentEditor = () =>
      containerA.querySelector<HTMLElement>(".lazers-models-assignment-editor")!
    const modelPicker = () =>
      currentAssignmentEditor().querySelector<HTMLButtonElement>(
        ".lazers-models-assignment-choice > button",
      )
    const pickerCallCount = () => nativePickerCalls.length
    const chooseCatalogModel = async () => {
      const before = pickerCallCount()
      nextNativePickerSelection = catalogSelection
      modelPicker()?.click()
      await until(() => pickerCallCount() === before + 1)
      await until(() => buttonWithText(currentAssignmentEditor(), "openai/gpt-6") !== undefined)
    }
    const chooseVariant = (variant: string) => {
      const editor = currentAssignmentEditor()
      const trigger = editor.querySelectorAll<HTMLButtonElement>(
        ".lazers-models-assignment-choice button",
      )[1]
      if (!trigger) throw new Error(`Missing effort trigger: ${editor.innerHTML}`)
      trigger.click()
      const item = menuItemWithText(containerA, variant)
      if (!item) throw new Error(`Missing variant ${variant}: ${editor.innerHTML}`)
      item.click()
    }

    const beforeCancelledPicker = pickerCallCount()
    modelPicker()?.click()
    await until(() => pickerCallCount() === beforeCancelledPicker + 1)
    expect(nativePickerCalls.at(-1)).toMatchObject({
      title: "Choose a model",
      placeholder: "Search model name, provider, or ID",
      current: undefined,
      options: [
        {
          title: "GPT-6",
          value: catalogSelection,
          description: "openai gpt-6 · chat",
          group: "openai",
        },
        {
          title: "GPT-6",
          value: JSON.stringify(["provider-b", "model-b"]),
          description: "provider-b model-b · chat",
          group: "provider-b",
        },
        {
          title: "GPT-6",
          value: JSON.stringify(["provider-a", "model-a"]),
          description: "provider-a model-a · chat",
          group: "provider-a",
        },
        {
          title: "GPT-6",
          value: JSON.stringify(["provider-a", "model-c"]),
          description: "provider-a model-c · chat",
          group: "provider-a",
        },
        {
          title: "An unusually long catalog-backed model display name",
          value: JSON.stringify(["provider-c", "model-with-long-name"]),
          description: "provider-c model-with-long-name · chat",
          group: "provider-c",
        },
        {
          title: "GPT-6 Luna",
          description: "openai gpt-6-luna · chat",
          group: "openai",
        },
        {
          title: "Qwen 7",
          description: "qwen qwen-7 · chat",
          group: "qwen",
        },
        { title: "Claude 4 Sonnet", group: "anthropic" },
      ],
    })
    const nativeOpenAISearchResults = nativePickerCalls
      .at(-1)!
      .options.filter(({ title, description }) =>
        `${title} ${description ?? ""}`.toLowerCase().includes("openai gpt-6-luna"),
      )
    expect(nativeOpenAISearchResults).toMatchObject([
      {
        title: "GPT-6 Luna",
        value: JSON.stringify(["openai", "gpt-6-luna"]),
        group: "openai",
        description: "openai gpt-6-luna · chat",
      },
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(modelPicker()?.textContent).toBe("openai/project-ui-route")

    const lateCatalogSelection = deferred<string | undefined>()
    pendingNativePickerSelection = lateCatalogSelection
    const beforeLatePicker = pickerCallCount()
    modelPicker()?.click()
    await until(() => pickerCallCount() === beforeLatePicker + 1)
    chooseScope("project")
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("project-ui-route") === true,
    )
    lateCatalogSelection.resolve(catalogSelection)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(modelPicker()?.textContent).toBe("openai/project-ui-route")

    chooseScope("project")
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("project-ui-route") === true,
    )
    await chooseCatalogModel()
    chooseVariant("high")
    buttonWithText(containerA.querySelector(".lazers-details-bar")!, "Save")?.click()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-feedback")
          ?.textContent?.includes("Saved") === true &&
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("openai / gpt-6 · high") === true,
    )
    const projectToolReadback = await Effect.runPromise(
      modelSettingsTool.execute({ taskID: TASK_A }, modelToolContext()),
    )
    const projectSettings = settingsAuthority.settings({ taskID: TASK_A })
    expect(projectToolReadback.output).toEqual(projectSettings)
    expect(projectSettings.personas[0]).toMatchObject({
      layers: {
        project: {
          revision: 2,
          route: { providerID: "openai", id: "gpt-6", variant: "high" },
        },
      },
    })
    expect(
      calls.some(
        (call) =>
          call.method === "configure" &&
          JSON.stringify(call.input) ===
            JSON.stringify({
              sessionID: sessionA.id,
              target: { scope: "project" },
              persona: "ui",
              expectedRevision: 1,
              route: { providerID: "openai", id: "gpt-6", variant: "high" },
            }),
      ),
    ).toBe(true)
    rowForPersona("Systems").click()
    rowForPersona("UI").click()
    await until(() => buttonWithText(currentAssignmentEditor(), "high") !== undefined)
    chooseScope("task")
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("route-1") === true,
    )
    await chooseCatalogModel()
    chooseVariant("xhigh")
    await until(() => buttonWithText(currentAssignmentEditor(), "xhigh") !== undefined)
    buttonWithText(containerA.querySelector(".lazers-details-bar")!, "Save")?.click()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-feedback")
          ?.textContent?.includes("Saved") === true &&
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("openai / gpt-6 · xhigh") === true,
    )
    assignmentLayers().open = true
    expect(assignmentLayers().textContent).toContain(
      "Task override: openai / gpt-6 · xhigh · revision 2",
    )
    expect(assignmentLayers().textContent).toContain(
      "Project override: openai / gpt-6 · high · revision 2",
    )
    assignmentLayers().open = false
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "configure" &&
          JSON.stringify(call.input) ===
            JSON.stringify({
              sessionID: sessionA.id,
              target: { scope: "task", taskID: TASK_A },
              persona: "ui",
              expectedRevision: 1,
              route: { providerID: "openai", id: "gpt-6", variant: "xhigh" },
            }),
      ),
    ).toBe(true)
    const uiToolReadback = await Effect.runPromise(
      modelSettingsTool.execute({ taskID: TASK_A }, modelToolContext()),
    )
    const uiServiceReadback = settingsAuthority.settings({ taskID: TASK_A })
    expect(uiToolReadback.output).toEqual(uiServiceReadback)
    expect(uiServiceReadback.personas[0]).toMatchObject({
      persona: "ui",
      layers: {
        task: {
          revision: 2,
          route: { providerID: "openai", id: "gpt-6", variant: "xhigh" },
        },
      },
      resolution: {
        status: "assigned",
        route: { providerID: "openai", id: "gpt-6", variant: "xhigh" },
        provenance: { target: { scope: "task", taskID: TASK_A }, revision: 2 },
      },
    })
    expect(
      containerA.querySelector(".lazers-models-assignment-row[aria-pressed='true']")?.textContent,
    ).toContain("gpt-6 · xhigh")
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "settings" &&
          JSON.stringify(call.input) === JSON.stringify({ sessionID: sessionA.id, taskID: TASK_A }),
      ),
    ).toBe(true)
    const comparisonInputs = calls
      .filter(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "comparison",
      )
      .map((call) => call.input)
    expect(comparisonInputs).toContainEqual({ sessionID: sessionA.id, limit: 100 })

    containerA
      .querySelector<HTMLButtonElement>('[role="tab"][aria-controls="lazers-models-compare-panel"]')
      ?.click()
    await until(() => containerA.querySelector(".lazers-models-inspector-compare") !== null)

    const topPaneBeforeRefresh = containerA.querySelector<HTMLElement>(".lazers-models-top")!
    const inspectorBeforeRefresh = containerA.querySelector<HTMLElement>(
      ".lazers-models-inspector",
    )!
    topPaneBeforeRefresh.scrollTop = 42
    topPaneBeforeRefresh.dispatchEvent(new Event("scroll"))
    inspectorBeforeRefresh.scrollTop = 55
    inspectorBeforeRefresh.dispatchEvent(new Event("scroll"))
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.topScroll).toBe(42)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.inspectorScroll).toBe(55)
    buttonWithText(containerA, "Refresh")?.click()
    topPaneBeforeRefresh.scrollTop = 0
    inspectorBeforeRefresh.scrollTop = 0
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("Objective A refreshed") === true &&
        containerA
          .querySelector(".lazers-models-task-objective")
          ?.textContent?.includes("Objective A refreshed") === true &&
        containerA.textContent?.includes("openai / gpt-6") === true,
    )
    expect(topPaneBeforeRefresh.scrollTop).toBe(42)
    expect(inspectorBeforeRefresh.scrollTop).toBe(55)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.tasks" &&
          call.method === "get",
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.observability" &&
          call.method === "trajectoryStatus",
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.tasks" &&
          call.method === "query" &&
          JSON.stringify(call.input) ===
            JSON.stringify({
              state: "all",
              includeCompleted: true,
              includeRetired: true,
              limit: 100,
            }),
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.tasks" &&
          call.method === "get" &&
          JSON.stringify(call.input) === JSON.stringify({ taskID: TASK_A }),
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.observability" &&
          call.method === "trajectoryStatus" &&
          JSON.stringify(call.input) ===
            JSON.stringify({ scope: { kind: "project", sessionID: sessionA.id }, taskID: TASK_A }),
      ),
    ).toBe(true)

    containerA
      .querySelector<HTMLButtonElement>(
        '[role="tab"][aria-controls="lazers-models-assignments-panel"]',
      )
      ?.click()
    await until(() => containerA.querySelector(".lazers-models-assignment-editor") !== null)
    buttonWithText(containerA, "Remove override")?.click()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-feedback")
          ?.textContent?.includes("Saved") === true &&
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("Removed") === true &&
        rowForPersona("UI").textContent?.includes("gpt-6 · high") === true,
    )
    const removedUIReadback = await Effect.runPromise(
      modelSettingsTool.execute({ taskID: TASK_A }, modelToolContext()),
    )
    const removedUISettings = settingsAuthority.settings({ taskID: TASK_A })
    expect(removedUIReadback.output).toEqual(removedUISettings)
    expect(removedUISettings.personas[0]).toMatchObject({
      layers: {
        task: { revision: 3, route: null },
        project: {
          revision: 2,
          route: { providerID: "openai", id: "gpt-6", variant: "high" },
        },
      },
      resolution: {
        status: "assigned",
        route: { providerID: "openai", id: "gpt-6", variant: "high" },
        provenance: { target: { scope: "project", projectDirectory: DIRECTORY_A }, revision: 2 },
      },
    })
    assignmentLayers().open = true
    expect(assignmentLayers().textContent).toContain("Task override: Removed · revision 3")
    expect(assignmentLayers().textContent).toContain(
      "Project override: openai / gpt-6 · high · revision 2",
    )
    assignmentLayers().open = false
    expect(
      calls.some(
        (call) =>
          call.method === "configure" &&
          JSON.stringify(call.input) ===
            JSON.stringify({
              sessionID: sessionA.id,
              target: { scope: "task", taskID: TASK_A },
              persona: "ui",
              expectedRevision: 2,
              route: null,
            }),
      ),
    ).toBe(true)

    rowForPersona("Systems").click()
    chooseScope("shared")
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-current")
          ?.textContent?.includes("Not set") === true,
    )
    const sharedRoute = {
      providerID: "provider-not-in-catalog",
      id: "manual/model-id",
      variant: "native/xhigh",
    }
    const manualRouteDetails = assignmentEditor.querySelector<HTMLDetailsElement>(
      ".lazers-models-assignment-manual-route",
    )!
    manualRouteDetails.open = true
    fillTextInput(containerA, "Provider ID", sharedRoute.providerID)
    fillTextInput(containerA, "Model ID", sharedRoute.id)
    fillTextInput(containerA, "Variant / effort (optional)", sharedRoute.variant)
    buttonWithText(containerA, "Save")?.click()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-assignment-feedback")
          ?.textContent?.includes("Saved") === true &&
        rowForPersona("Systems").textContent?.includes("manual/model-id · native/xhigh") === true,
    )
    const systemsToolReadback = await Effect.runPromise(
      modelSettingsTool.execute({ taskID: TASK_A }, modelToolContext()),
    )
    const systemsSettings = settingsAuthority.settings({ taskID: TASK_A })
    expect(systemsToolReadback.output).toEqual(systemsSettings)
    expect(systemsSettings.personas[1]).toMatchObject({
      layers: { shared: { revision: 1, route: sharedRoute } },
      resolution: {
        status: "assigned",
        route: sharedRoute,
        provenance: { target: { scope: "shared" }, revision: 1 },
      },
    })
    expect(
      calls.some(
        (call) =>
          call.method === "configure" &&
          JSON.stringify(call.input) ===
            JSON.stringify({
              sessionID: sessionA.id,
              target: { scope: "shared" },
              persona: "systems",
              expectedRevision: 0,
              route: sharedRoute,
            }),
      ),
    ).toBe(true)
    rowForPersona("Small task / refactoring").click()
    expect(
      assignmentRows().filter((row) => row.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1)
    expect(containerA.querySelectorAll(".lazers-models-assignment-editor")).toHaveLength(1)
    expect(containerA.textContent).not.toContain("Saved assignments do not change worker dispatch")

    containerA
      .querySelector<HTMLButtonElement>('[role="tab"][aria-controls="lazers-models-compare-panel"]')
      ?.click()
    await until(() => containerA.querySelector(".lazers-models-inspector-compare") !== null)
    // Persona and kind only: the task chip shows for a chosen task filter, not by default.
    expect(containerA.querySelectorAll(".lazers-models-filters .lazers-models-chip")).toHaveLength(
      2,
    )
    expect(containerA.querySelector(".lazers-models-assignment-editor")).toBeNull()
    const effortDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    const sourceDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    effortDetailsBeforeRefresh.open = true
    sourceDetailsBeforeRefresh.open = true

    await until(() => buttonWithText(containerA, "Refresh")?.disabled === false)
    const sourceSignalsBeforePinnedRefresh = sourceSignals.get(DIRECTORY_A)?.length ?? 0
    buttonWithText(containerA, "Refresh")?.click()
    await until(
      () => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === sourceSignalsBeforePinnedRefresh + 1,
    )
    const hiddenSignal = sourceSignals.get(DIRECTORY_A)?.[sourceSignalsBeforePinnedRefresh]
    expect(containerA.querySelector(".lazers-models-all-models")?.textContent).toContain("GPT-6")
    expect(containerA.querySelector(".lazers-models-decision-rows")).toBeNull()
    expect(
      containerA.querySelector(".lazers-models-task-effort-details")?.closest("details")?.open,
    ).toBe(true)
    expect(
      containerA.querySelector<HTMLDetailsElement>(".lazers-models-sources-details")?.open,
    ).toBe(true)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)
    mountA.setVisible(false)
    await until(() => hiddenSignal?.aborted === true)
    const beforeLateHiddenResult = comparisonCounts.get(DIRECTORY_A)
    const rpcsBeforeLocationReopen = calls.filter((call) => call.service !== "location").length
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 2)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    // The cached comparison for this same project shows at once; no read starts until the
    // location is confirmed.
    expect(containerA.querySelector(`[data-point-id="${CONFIG_ONE}"]`)).not.toBeNull()
    mountA.setVisible(false)
    await until(() => locationSignals.get(DIRECTORY_A)?.[1]?.aborted === true)
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 3)
    expect(locationSignals.get(DIRECTORY_A)?.[1]?.aborted).toBe(true)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    // The cached comparison for this same project shows at once; no read starts until the
    // location is confirmed.
    expect(containerA.querySelector(`[data-point-id="${CONFIG_ONE}"]`)).not.toBeNull()
    deferredLocationA2.resolve(locationResult(DIRECTORY_A))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    const connectionCountsBeforeReopen = connectionCounts(DIRECTORY_A)
    deferredLocationA3.resolve(locationResult(DIRECTORY_A))
    await until(() => connectedOnceSince(DIRECTORY_A, connectionCountsBeforeReopen))
    await until(
      () => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === sourceSignalsBeforePinnedRefresh + 2,
    )
    await new Promise<void>((r) => setTimeout(r, 500))
    console.log("DBG", comparisonCounts.get(DIRECTORY_A), beforeLateHiddenResult)
    await until(() => (comparisonCounts.get(DIRECTORY_A) ?? 0) >= (beforeLateHiddenResult ?? 0) + 2)
    const afterReconnectComparisons = comparisonCounts.get(DIRECTORY_A)
    deferredA3.resolve(sourceEvidence())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(comparisonCounts.get(DIRECTORY_A)).toBe(afterReconnectComparisons)
    expect(containerA.querySelector(".lazers-models-all-models")?.textContent).toContain("GPT-6")
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)

    const rpcsBeforeSessionSwitch = calls.filter((call) => call.service !== "location").length
    sessionScope.update((draft: { id: string; directory: string }) => {
      draft.id = "ses-models-switched"
      draft.directory = DIRECTORY_B
    })
    await until(() => (locationSignals.get(DIRECTORY_B)?.length ?? 0) === 1)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeSessionSwitch,
    )
    // A different project has no cached comparison: it starts empty, never showing project A's.
    expect(containerA.querySelector(`[data-point-id="${CONFIG_ONE}"]`)).toBeNull()
    sessionScope.update((draft: { id: string; directory: string }) => {
      draft.id = "ses-models-panel"
      draft.directory = DIRECTORY_A
    })
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 4)
    expect(locationSignals.get(DIRECTORY_B)?.[0]?.aborted).toBe(true)
    const rpcsBeforeLateProjectResult = calls.filter((call) => call.service !== "location").length
    deferredLocationB1.resolve(locationResult(DIRECTORY_B))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLateProjectResult,
    )
    deferredLocationA4.reject(new Error("location lookup failed"))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLateProjectResult,
    )
    const comparisonsBeforeRetry = comparisonCounts.get(DIRECTORY_A) ?? 0
    const connectionCountsBeforeRetry = connectionCounts(DIRECTORY_A)
    const sourceSignalsBeforeRetry = sourceSignals.get(DIRECTORY_A)?.length ?? 0
    mountA.setVisible(false)
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 5)
    await until(() => connectedOnceSince(DIRECTORY_A, connectionCountsBeforeRetry))
    await until(
      () => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === sourceSignalsBeforeRetry + 1,
    )
    await until(() => (comparisonCounts.get(DIRECTORY_A) ?? 0) >= comparisonsBeforeRetry + 2)
    expect(counts.get(`${DIRECTORY_A}:refreshSources`)).toBe(5)

    await until(() => !buttonWithText(containerA, "Refresh")?.disabled)
    const retainedEffort = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    const retainedSources = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    retainedEffort.open = true
    retainedSources.open = true
    expect(containerA.querySelector(".lazers-panel-banner")).toBeNull()
    const sourceCountBeforeComparisonFailure = sourceSignals.get(DIRECTORY_A)?.length ?? 0
    const comparisonCountBeforeComparisonFailure = comparisonCounts.get(DIRECTORY_A) ?? 0
    failNextComparison = true
    buttonWithText(containerA, "Refresh")?.click()
    await until(
      () =>
        containerA.querySelector(".lazers-panel-banner") !== null ||
        ((sourceSignals.get(DIRECTORY_A)?.length ?? 0) > sourceCountBeforeComparisonFailure &&
          (comparisonCounts.get(DIRECTORY_A) ?? 0) > comparisonCountBeforeComparisonFailure &&
          !buttonWithText(containerA, "Refresh")?.disabled),
    )
    if (containerA.querySelector(".lazers-panel-banner") === null)
      throw new Error(
        `Expected comparison failure was not shown (comparison ${comparisonCountBeforeComparisonFailure}→${comparisonCounts.get(DIRECTORY_A)}, source ${sourceCountBeforeComparisonFailure}→${sourceSignals.get(DIRECTORY_A)?.length}): ${containerA.textContent}`,
      )
    const staleWarning = containerA.querySelector<HTMLElement>(".lazers-panel-banner")!
    expect(staleWarning.textContent).toContain("Couldn't update comparison")
    expect(staleWarning.closest("details")).toBeNull()
    expect(containerA.querySelector("[data-panel-dimmed='true']")).not.toBeNull()
    expect(retainedEffort.open).toBe(true)
    expect(retainedSources.open).toBe(true)
    expect(retainedSources.textContent).toContain(
      "Comparison read error: comparison request unavailable",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)

    await until(() => !buttonWithText(containerA, "Refresh")?.disabled)
    const sourceSignalsBeforeFailedRefresh = sourceSignals.get(DIRECTORY_A)?.length ?? 0
    buttonWithText(containerA, "Refresh")?.click()
    await until(
      () => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === sourceSignalsBeforeFailedRefresh + 1,
    )
    await until(
      () => retainedSources.textContent?.includes("Source refresh error: source request") === true,
    )
    const failedRefreshWarning = containerA.querySelector<HTMLElement>(".lazers-panel-banner")!
    expect(failedRefreshWarning.closest("details")).toBeNull()
    expect(containerA.querySelector(".lazers-models-task-effort-details")).toBe(retainedEffort)
    expect(containerA.querySelector(".lazers-models-sources-details")).toBe(retainedSources)
    expect(retainedEffort.open).toBe(true)
    expect(retainedSources.open).toBe(true)
    expect(retainedSources.textContent).toContain(
      "Source refresh error: source request unavailable",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)

    const containerB = browserDocument.createElement("main")
    browserDocument.body.append(containerB)
    const mountB = host.mountModelPanel(panel!, context, sessionB, containerB)
    mounts.push(mountB)
    await until(
      () =>
        containerB.querySelector(
          `.lazers-models-all-models [data-configuration-id="${CONFIG_ONE}"]`,
        ) !== null && containerB.textContent?.includes("Objective B project only") === true,
    )
    expect(containerB.querySelector(".lazers-models-all-models")?.textContent).toContain("gpt-6")
    const assignmentsTabB = containerB.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="lazers-models-assignments-panel"]',
    )
    if (!assignmentsTabB) throw new Error(`Missing assignments tab in B: ${containerB.innerHTML}`)
    assignmentsTabB.click()
    await until(() => containerB.querySelectorAll(".lazers-models-assignment-row").length === 3)
    const uiAssignmentRowB = containerB.querySelector<HTMLButtonElement>(
      ".lazers-models-assignment-row",
    )!
    uiAssignmentRowB.click()
    await until(() => containerB.textContent?.includes("Model catalog unavailable") === true)
    const manualRouteDetailsB = containerB.querySelector<HTMLDetailsElement>(
      ".lazers-models-assignment-manual-route",
    )!
    manualRouteDetailsB.open = true
    expect(
      [...manualRouteDetailsB.querySelectorAll<HTMLInputElement>("input")].every(
        (input) => !input.disabled,
      ),
    ).toBe(true)
    expect(buttonWithText(containerB, "Retry catalog")).toBeDefined()
    expect(
      containerB.querySelector<HTMLButtonElement>(".lazers-models-assignment-choice > button")
        ?.disabled,
    ).toBe(true)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_B]?.selectedTaskID).toBe(TASK_B)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_B &&
          call.service === "lazers.models" &&
          call.method === "settings" &&
          JSON.stringify(call.input) === JSON.stringify({ sessionID: sessionB.id }),
      ),
    ).toBe(true)

    buttonWithText(containerB, "Refresh")?.click()
    await until(() => (sourceSignals.get(DIRECTORY_B)?.length ?? 0) === 2)
    const disposedSignal = sourceSignals.get(DIRECTORY_B)?.[1]
    const comparisonsBeforeDispose = comparisonCounts.get(DIRECTORY_B)
    mountB.dispose()
    await until(() => disposedSignal?.aborted === true)
    deferredB2.resolve(sourceEvidence())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(comparisonCounts.get(DIRECTORY_B)).toBe(comparisonsBeforeDispose)
    expect(containerB.textContent).toBe("")
    mounts.splice(mounts.indexOf(mountB), 1)

    for (const call of calls.filter((entry) => entry.service !== "location"))
      expect(call.signal).toBeDefined()
  } finally {
    for (const mount of mounts.reverse()) mount.dispose()
    disposeSetup?.()
    assignmentAuthorityRepository?.close()
    if (assignmentAuthorityDirectory)
      rmSync(assignmentAuthorityDirectory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
    await dom.happyDOM.abort()
    for (const name of globalNames) {
      const prior = previousGlobals.get(name)
      if (prior) Object.defineProperty(globalThis, name, prior)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}, 15_000)
