import { Store, bindPlugin, createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import type { PanelProps, SetupContext } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import { Models } from "./contract.ts"
import type { KnownUsageMarketScenario } from "./market-range.ts"
import type { ModelPolicy, WorkerPersona } from "../runner/schema.ts"
import type { ModelMappingTargetInput } from "./mapping-schema.ts"
import { ModelsDecision } from "./decision-contract.ts"
import type {
  ModelDecisionConfiguration,
  ModelDecisionFilters,
  ModelDecisionRow,
  ModelDecisionTaskKind,
} from "./decision-contract.ts"
import {
  ComparisonChart,
  comparisonChartHasPlottablePoints,
  comparisonChartKeyboardOrder,
} from "./comparison-chart.tsx"
import { BenchmarkChart, benchmarkSourceName } from "./benchmark-chart.tsx"
import { BENCHMARK_PRICE_MIX, benchmarkBaseline, routeKey } from "./benchmark-baseline.ts"
import type { BenchmarkRoute } from "./benchmark-baseline.ts"
import { MODEL_PRICE_SOURCES } from "./price-source-settings.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./comparison-chart.tsx"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import { emptyModelDecisionFilters } from "./comparison-state.ts"
import { Tasks } from "../tasks/contract.ts"
import { Observability } from "../observability/contract.ts"
import type { TaskTrajectoryOpener } from "../tasks/panel.tsx"
import type { TaskTrajectoryRequest } from "../tasks/panel.tsx"
import { registerModelsPanel } from "./registration.ts"
import type {
  ModelCatalogOutput,
  ModelComparisonPanelData,
  ModelComparisonTransport,
} from "./comparison-state.ts"
import { ModelComparisonPanelState } from "./comparison-state.ts"
import type { ModelCandidate } from "./comparison-state.ts"
import {
  boundedModelLabel,
  formatDate,
  formatMarketAmount,
  currentMarketEstimateSummary,
  modelDisplayLabel,
  numericValue,
  recordReferenceLabel,
  routeLabel,
  sourceState,
  sourceTitle,
} from "./comparison-presentation.ts"
import css from "./comparison-panel.css?inline"

const Preference = Schema.Struct({
  tab: Schema.Literals(["compare", "assignments"]),
  persona: Schema.NullOr(Schema.Literals(["ui", "systems", "small-refactoring"])),
  taskKind: Schema.optional(
    Schema.NullOr(
      Schema.Literals([
        "bug-repair",
        "feature-implementation",
        "refactoring",
        "testing",
        "documentation",
        "maintenance",
      ]),
    ),
  ),
  selectedTaskID: Schema.NullOr(Schema.String),
  selectedCandidateID: Schema.NullOr(Schema.String),
  selectedConfigurationID: Schema.optional(Schema.NullOr(Schema.String)),
  split: Schema.Number,
  evidenceOpen: Schema.optional(Schema.Boolean),
  /** Explicit comparison choice; absent means pick from the available data. */
  compareMode: Schema.optional(Schema.NullOr(Schema.Literals(["observed", "benchmark"]))),
  topScroll: Schema.Number,
  inspectorScroll: Schema.Number,
})
const initial: typeof Preference.Type = {
  tab: "compare",
  persona: null,
  taskKind: null,
  selectedTaskID: null,
  selectedCandidateID: null,
  selectedConfigurationID: null,
  split: 64,
  evidenceOpen: false,
  topScroll: 0,
  inspectorScroll: 0,
}

export const modelsStores = {
  modelsView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, Preference) }), {
    projects: {},
  }),
}

type ModelsContext = SetupContext<{ stores: typeof modelsStores }>
type Tab = "compare" | "assignments"
const modelPersonaLabels = {
  ui: "UI",
  systems: "Systems",
  "small-refactoring": "Small task / refactoring",
} as const
const modelTaskKindLabels: Record<ModelDecisionTaskKind, string> = {
  "bug-repair": "Bug repair",
  "feature-implementation": "Feature implementation",
  refactoring: "Refactoring",
  testing: "Testing",
  documentation: "Documentation",
  maintenance: "Maintenance",
}
const modelTaskKinds = Object.keys(modelTaskKindLabels) as ModelDecisionTaskKind[]

const clampSplit = (value: number) => Math.min(76, Math.max(24, value))
/** Plot height bounds; the pane supplies the height in between. */
const chartHeightBounds = { minimum: 168, maximum: 320 } as const
/** Legend, Chart data summary and pane padding kept visible below the plot. */
const chartFooterReserve = 56

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString()
}

function benchmarkLabel(candidate: ModelCandidate) {
  const benchmark = candidate.externalBenchmark
  if (!benchmark) {
    return candidate.benchmarkCorrespondence.status === "ambiguous"
      ? "Ambiguous benchmark match"
      : "No matched benchmark"
  }
  return benchmark.codingIndex === null
    ? "Coding index not reported"
    : `Coding index ${benchmark.codingIndex}`
}

function personaFilterLabel(persona: typeof initial.persona) {
  if (!persona) return "All"
  return persona === "small-refactoring" ? "Refactor" : modelPersonaLabels[persona]
}

/** Short source name for the summary line; freshness only when it is not current. */
function marketSummarySource(context: string) {
  const [source = "", ...details] = context.split(" · ")
  const name =
    {
      "OpenRouter model catalog": "OpenRouter",
      "OpenCode model catalog": "OpenCode",
      "Configured price sources": "Configured sources",
      "Configured price source": "Configured source",
    }[source] ?? source
  return details.includes("stale") ? `${name} · out of date` : name
}

function decisionStatusLabel(status: ModelComparisonPanelData["decisionStatus"]) {
  switch (status) {
    case "loading":
      return "Loading comparison data"
    case "ready":
      return "Comparison data is current"
    case "partial":
      return "Some comparison data is missing"
    case "stale":
      return "Comparison data may be out of date"
    case "unknown":
      return "Comparison data age is unknown"
    case "backend-not-ready":
      return "Comparison data is not ready yet"
    case "missing-rpc":
      return "Comparison is not available on this server"
    case "error":
      return "Comparison data could not be loaded"
  }
}

function decisionStatusSummary(status: ModelComparisonPanelData["decisionStatus"]) {
  switch (status) {
    case "loading":
      return "Loading"
    case "ready":
      return "Current"
    case "partial":
      return "Incomplete"
    case "stale":
      return "Out of date"
    case "unknown":
      return "Age unknown"
    case "backend-not-ready":
      return "Not ready"
    case "missing-rpc":
      return "Unavailable"
    case "error":
      return "Couldn't load"
  }
}

function efficiencyLabel(row: ModelDecisionRow) {
  const efficiency = row.efficiency
  switch (efficiency.status) {
    case "available":
      return `${formatNumber(efficiency.tokensPerAcceptedTask)} tokens · ${formatMoney(efficiency.currentMarketUSDPerAcceptedTask)} per accepted task · ${efficiency.observationCount} observations`
    case "single-observation":
      return `${formatNumber(efficiency.tokensPerAcceptedTask)} tokens · ${formatMoney(efficiency.currentMarketUSDPerAcceptedTask)} · n=1`
    case "partial":
      return `Partial · ${efficiency.tokensPerAcceptedTask === null ? "tokens unknown" : `${formatNumber(efficiency.tokensPerAcceptedTask)} tokens`} · ${efficiency.currentMarketUSDPerAcceptedTask === null ? "current price unknown" : formatMoney(efficiency.currentMarketUSDPerAcceptedTask)}`
    case "zero-accepted":
      return "No accepted tasks; no efficiency coordinate"
    case "unknown":
      return `Unknown · ${efficiency.reason}`
  }
}

function formatMoney(value: number | null) {
  return value === null
    ? "Unknown market cost"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumSignificantDigits: 12,
      }).format(value)
}

function moneyRangeLabel(range: { minimum: number; maximum: number }) {
  return range.minimum === range.maximum
    ? formatMoney(range.minimum)
    : `${formatMoney(range.minimum)}–${formatMoney(range.maximum)}`
}

function referenceCostLabel(estimate: ModelDecisionReferenceEstimate) {
  switch (estimate.status) {
    case "exact":
      return estimate.valueUSDPerAcceptedTask === null
        ? "No numeric OpenRouter model catalog reference amount"
        : `OpenRouter model catalog scalar reference · ${formatMoney(estimate.valueUSDPerAcceptedTask)} / accepted task`
    case "conditional":
      return estimate.rangeUSDPerAcceptedTask
        ? `OpenRouter model catalog conditional range · ${moneyRangeLabel(estimate.rangeUSDPerAcceptedTask)} / accepted task`
        : "No numeric OpenRouter model catalog range amount"
    case "partial":
      if (estimate.knownSubtotalUSDPerAcceptedTask !== null)
        return `OpenRouter model catalog priced subtotal only · ${formatMoney(estimate.knownSubtotalUSDPerAcceptedTask)} / accepted task · remainder unknown`
      if (estimate.knownSubtotalRangeUSDPerAcceptedTask)
        return `OpenRouter model catalog priced subtotal range only · ${moneyRangeLabel(estimate.knownSubtotalRangeUSDPerAcceptedTask)} / accepted task · remainder unknown`
      return "No priced portion is shown; total unknown"
    case "zero-accepted":
      return "No accepted tasks · no reference per-task amount"
    case "unavailable":
      return "No numeric OpenRouter model catalog reference amount"
  }
}

const referenceUsageCategories = [
  ["uncachedInput", "Uncached input"],
  ["output", "Output"],
  ["reasoning", "Reasoning"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
] as const

function referenceCategoryStatus(estimate: ModelDecisionReferenceEstimate, category: string) {
  const usage = estimate.coverage.categories[category as keyof typeof estimate.coverage.categories]
  return `${usage.tokens === null ? "tokens unknown" : `${formatNumber(usage.tokens)} tokens`} · ${usage.status} usage · ${usage.rateCoverage} rate coverage`
}

const knownUsageCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 12,
})

function formatKnownUsageMoney(value: number | null) {
  return value === null ? "Unavailable" : knownUsageCurrency.format(value)
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

function knownUsageSourcePresentation(source: string) {
  switch (source) {
    case "openrouter-endpoints":
      return {
        compact: "OpenRouter endpoint pricing",
        pricing: "OpenRouter endpoint pricing",
        sourceLink: "OpenRouter endpoint source",
        range: "Endpoint range",
        tierSelector: "Endpoint tier selector",
        scenario: "endpoint scenario",
      }
    case "openrouter-models":
      return {
        compact: "OpenRouter model catalog pricing",
        pricing: "OpenRouter model catalog pricing",
        sourceLink: "OpenRouter model catalog source",
        range: "OpenRouter model catalog range",
        tierSelector: "OpenRouter model catalog tier selector",
        scenario: "OpenRouter model catalog scenario",
      }
    case "native-catalog":
      return {
        compact: "Native catalog pricing",
        pricing: "Native catalog pricing",
        sourceLink: "Native model catalog source",
        range: "Native catalog range",
        tierSelector: "Native catalog tier selector",
        scenario: "native catalog scenario",
      }
    default:
      return {
        compact: "Pricing source unavailable",
        pricing: "Pricing source unavailable",
        sourceLink: "Pricing source",
        range: "Conditional range",
        tierSelector: "Pricing tier selector",
        scenario: "pricing scenario",
      }
  }
}

function formatKnownUsageRange(
  range: { minimum: number; maximum: number } | null,
  alwaysShowEndpoints = false,
) {
  if (!range) return "Unavailable"
  const minimum = formatKnownUsageMoney(range.minimum)
  if (!alwaysShowEndpoints && range.minimum === range.maximum) return minimum
  return `${minimum}–${formatKnownUsageMoney(range.maximum)}`
}

function knownUsageValueLabel(scenario: KnownUsageMarketScenario) {
  switch (scenario.status) {
    case "exact":
      return scenario.valueUSD === null
        ? "Unavailable · amount not supplied"
        : `${scenario.tierAttribution.status === "resolved-per-call" ? "Known-tier scenario amount" : "Scenario amount"} · ${formatKnownUsageMoney(scenario.valueUSD)}`
    case "range":
      return scenario.rangeUSD === null
        ? "Unavailable · range not supplied"
        : `${knownUsageSourcePresentation(scenario.provenance.source).range} · ${formatKnownUsageRange(scenario.rangeUSD, true)}`
    case "partial":
      return scenario.knownSubtotalUSD === null
        ? "Unavailable · not a zero price"
        : `Known subtotal only · ${formatKnownUsageRange(scenario.knownSubtotalUSD)}`
    case "unavailable":
      return "Unavailable · not a zero price"
  }
}

function knownUsageEssentialDescription(scenario: KnownUsageMarketScenario) {
  const source = knownUsageSourcePresentation(scenario.provenance.source)
  const conditions = [
    scenario.tierAttribution.status === "unresolved"
      ? "prompt tier unresolved"
      : scenario.tierAttribution.status === "unsupported"
        ? `${source.tierSelector.toLowerCase()} unsupported`
        : null,
    scenario.coverage.retries.status === "complete"
      ? null
      : `retry coverage ${scenario.coverage.retries.status}`,
  ].filter((condition): condition is string => condition !== null)

  if (
    scenario.status === "unavailable" ||
    (scenario.status === "partial" && !scenario.knownSubtotalUSD) ||
    (scenario.status === "exact" && scenario.valueUSD === null) ||
    (scenario.status === "range" && scenario.rangeUSD === null)
  )
    return "Unavailable from retained evidence · not a zero price."

  if (scenario.status === "partial")
    return `Partial known-usage subtotal only${conditions.length ? ` · ${conditions.join(" · ")}` : ""} · not a complete-task or whole-history bound.`

  if (scenario.status === "range" || conditions.length)
    return `Conditional ${source.scenario}${conditions.length ? ` · ${conditions.join(" · ")}` : ""} · known retained usage only, not a complete-task or whole-history bound or actual charges.`

  return "Known retained usage only · not actual charges or a complete-task bound."
}

function knownUsageTierDescription(scenario: KnownUsageMarketScenario) {
  const tier = scenario.tierAttribution
  const selected = tier.selectedTierIDs.length ? tier.selectedTierIDs.join(", ") : "none resolved"
  switch (tier.status) {
    case "not-required":
      return `Tier attribution not required for the single published rate scenario · rate tier ${selected}.`
    case "resolved-per-call":
      return `Prompt tiers resolved per call · ${countLabel(tier.callCount, "measured call")} · selected tiers ${selected}.`
    case "unresolved":
      return `Prompt tier unresolved · available tiers ${selected}. Any range is conditional for known retained usage only, not a complete-task or whole-history bound.`
    case "unsupported":
      return `${knownUsageSourcePresentation(scenario.provenance.source).tierSelector} unsupported by retained usage evidence · no unsupported tier is inferred.`
  }
}

function knownUsageRetryDescription(scenario: KnownUsageMarketScenario) {
  const retries = scenario.coverage.retries
  const description =
    `Retry coverage ${retries.status} · ${countLabel(retries.attemptCount, "attempt")} · ` +
    `${countLabel(retries.failedAttemptCount, "failed attempt")} · ` +
    `${countLabel(retries.retryAttemptCount, "retry", "retries")} · ` +
    `${countLabel(retries.attemptsWithCompleteUsage, "attempt with complete measured usage")}.`
  return retries.status === "complete"
    ? `${description} Coverage is complete only for retained matching usage, not a complete-task bound.`
    : `${description} Incomplete retry history is conditional and cannot bound the complete task or whole history.`
}

function knownUsageCacheWriteDescription(scenario: KnownUsageMarketScenario) {
  const evidence = scenario.cacheWriteEvidence
  switch (evidence.basis) {
    case "scoped-documentation":
      return `Cache-write pricing uses scoped documentation${evidence.policyID ? ` · ${evidence.policyID}` : ""}; any documented zero applies only to this scenario.`
    case "endpoint-rate":
      return "Cache-write pricing uses the published rate for this exact endpoint scenario only; it does not establish general cache-write capability or availability."
    case "published-model-rate":
      return "Cache-write pricing uses the published OpenRouter model rate for this exact scenario only; it does not establish general cache-write capability or availability."
    case "published-native-quote":
      return "Cache-write pricing uses the published native catalog quote for this exact scenario only; it does not establish general cache-write capability or availability."
    case "zero-usage-rate-not-required":
      return "No cache-write rate was needed for the measured zero usage; zero observed writes do not mean cache writes are free."
    case "missing":
      return "Cache-write pricing evidence is missing; no zero rate or free usage is assumed."
  }
}

function knownUsageCategoryRows(scenario: KnownUsageMarketScenario) {
  return [
    ["Uncached input", scenario.coverage.categories.uncachedInput],
    ["Output", scenario.coverage.categories.output],
    ["Reasoning", scenario.coverage.categories.reasoning],
    ["Cache read", scenario.coverage.categories.cacheRead],
    ["Cache write", scenario.coverage.categories.cacheWrite],
  ] as const
}

/** Keep endpoint-scenario values visually and semantically separate from empirical estimates. */
export function KnownUsageMarketScenarioCard(props: { scenario: KnownUsageMarketScenario }) {
  const scenario = () => props.scenario
  const valueLabel = () => knownUsageValueLabel(scenario())
  const essentialDescription = () => knownUsageEssentialDescription(scenario())
  const provenance = () => scenario().provenance
  const sourcePresentation = () => knownUsageSourcePresentation(provenance().source)
  const freshness = () =>
    scenario().freshness === "current"
      ? "Current"
      : scenario().freshness === "stale"
        ? "Stale"
        : "Unavailable"
  const routeCoverage = () => scenario().coverage.route
  const retries = () => scenario().coverage.retries

  return (
    <section
      class="lazers-models-market-scenario"
      data-status={scenario().status}
      aria-label="Current-market equivalent of known retained usage"
    >
      <h3>Current-market equivalent of known retained usage</h3>
      <p class="lazers-models-market-value">
        <strong>{valueLabel()}</strong>
      </p>
      <p class="lazers-models-market-meta">
        {sourcePresentation().compact} · provider {provenance().providerName ?? "unavailable"} · tag{" "}
        {provenance().tag ?? "unavailable"} · service tier{" "}
        {provenance().serviceTier ?? "not specified"} · {freshness()} ·{" "}
        {formatDate(provenance().retrievedAt)}
      </p>
      <p class="lazers-models-market-caveat">{essentialDescription()}</p>
      <details class="lazers-models-evidence-details lazers-models-market-evidence-details">
        <summary>Evidence &amp; assumptions</summary>
        <div class="lazers-models-evidence-content">
          <p>
            {scenario().label} · scenario {scenario().id} · status {scenario().status} · usage scope{" "}
            {scenario().coverage.scope} · whole-task bound{" "}
            {scenario().coverage.wholeTaskBound ? "yes" : "no"}. Not actual charges or an empirical
            predictive interval.
          </p>
          <p>{knownUsageTierDescription(scenario())}</p>
          <p>
            Measured usage · {routeCoverage().includedSessionCount.toLocaleString()} of{" "}
            {routeCoverage().relatedSessionCount.toLocaleString()} related sessions included · exact
            route matched in {routeCoverage().matchedRouteSessionCount.toLocaleString()}.
          </p>
          <p>{knownUsageRetryDescription(scenario())}</p>
          <p>{knownUsageCacheWriteDescription(scenario())}</p>
          <Show when={scenario().reason}>{(reason) => <p>{reason()}</p>}</Show>
          <div class="lazers-models-market-evidence">
            <dl class="lazers-models-evidence-summary">
              <dt>Pricing source</dt>
              <dd>
                {sourcePresentation().pricing} · basis {provenance().priceBasis} ·{" "}
                {provenance().productID} · refresh {provenance().refreshState} · snapshot generation{" "}
                {provenance().snapshotGeneration?.toLocaleString() ?? "unavailable"} · current
                generation {provenance().currentGeneration?.toLocaleString() ?? "unavailable"}
              </dd>
              <dt>{sourcePresentation().sourceLink}</dt>
              <dd>
                <Show when={provenance().sourceURL} fallback={<span>Source unavailable</span>}>
                  {(sourceURL) => (
                    <a href={sourceURL()} target="_blank" rel="noreferrer">
                      {sourceURL()}
                    </a>
                  )}
                </Show>
              </dd>
              <dt>Source record</dt>
              <dd>
                Snapshot {provenance().snapshotID ?? "unavailable"} · record index{" "}
                {provenance().recordIndex?.toLocaleString() ?? "unavailable"}
              </dd>
              <dt>Scenario status</dt>
              <dd>
                {scenario().id} · {scenario().status} · {scenario().freshness}
              </dd>
              <dt>Cache-write evidence</dt>
              <dd>
                {scenario().cacheWriteEvidence.basis} · policy{" "}
                {scenario().cacheWriteEvidence.policyID ?? "unavailable"} · source{" "}
                {scenario().cacheWriteEvidence.sourceURL ??
                  (scenario().cacheWriteEvidence.basis === "endpoint-rate"
                    ? provenance().sourceURL
                    : "unavailable")}{" "}
                · retrieved {formatDate(scenario().cacheWriteEvidence.retrievedAt)}
              </dd>
              <dt>Tier attribution</dt>
              <dd>
                {scenario().tierAttribution.status} · {scenario().tierAttribution.basis} ·{" "}
                {scenario().tierAttribution.selectedTierIDs.length
                  ? scenario().tierAttribution.selectedTierIDs.join(", ")
                  : "no selected tier IDs"}
              </dd>
              <dt>Tier thresholds</dt>
              <dd>
                {scenario().tierAttribution.promptThresholds.length
                  ? `${scenario()
                      .tierAttribution.promptThresholds.map((threshold) =>
                        threshold.toLocaleString(),
                      )
                      .join(", ")} prompt tokens`
                  : "Not reported"}
                {scenario().tierAttribution.thresholdSemantics
                  ? ` · ${scenario().tierAttribution.thresholdSemantics}`
                  : " · threshold semantics unavailable"}
              </dd>
              <dt>Missing endpoint rates</dt>
              <dd>
                {scenario().missingRates.length
                  ? scenario().missingRates.join(", ")
                  : "None reported"}
              </dd>
            </dl>
            <div class="lazers-models-market-coverage">
              <h4>Measured token categories</h4>
              <For each={knownUsageCategoryRows(scenario())}>
                {([label, category]) => (
                  <p>
                    <strong>{label}</strong> ·{" "}
                    {category.tokens === null
                      ? "tokens unavailable"
                      : countLabel(category.tokens, "token")}{" "}
                    · {statusText(category.status)}
                  </p>
                )}
              </For>
              <p>
                Route sessions ·{" "}
                {countLabel(routeCoverage().relatedSessionCount, "related session")} ·{" "}
                {countLabel(routeCoverage().matchedRouteSessionCount, "exact-route match")} ·{" "}
                {countLabel(routeCoverage().includedSessionCount, "included session")} ·{" "}
                {countLabel(routeCoverage().otherRouteSessionCount, "other-route session")} ·{" "}
                {countLabel(routeCoverage().mixedRouteSessionCount, "mixed-route session")} ·{" "}
                {countLabel(routeCoverage().unknownRouteSessionCount, "unknown-route session")} ·{" "}
                {countLabel(routeCoverage().sharedSessionCount, "shared session excluded")}.
              </p>
              <p>
                Attempts · {countLabel(retries().attemptCount, "total attempt")} ·{" "}
                {countLabel(retries().routeMatchedAttemptCount, "route-matched attempt")} ·{" "}
                {countLabel(retries().failedAttemptCount, "failed attempt")} ·{" "}
                {countLabel(retries().retryAttemptCount, "retry", "retries")} ·{" "}
                {countLabel(retries().otherRouteAttemptCount, "other-route attempt")} ·{" "}
                {countLabel(retries().mixedRouteAttemptCount, "mixed-route attempt")} ·{" "}
                {countLabel(retries().unknownRouteAttemptCount, "unknown-route attempt")} ·{" "}
                {countLabel(retries().sharedAttemptCount, "shared attempt")} ·{" "}
                {countLabel(retries().attemptsWithCompleteUsage, "attempt with complete usage")} ·{" "}
                {countLabel(
                  retries().failedAttemptsWithCompleteUsage,
                  "failed attempt with complete usage",
                )}{" "}
                ·{" "}
                {countLabel(
                  retries().retryAttemptsWithCompleteUsage,
                  "retry with complete usage",
                  "retries with complete usage",
                )}
                .
              </p>
            </div>
            <div class="lazers-models-market-rates">
              <h4>Published rates · USD per token</h4>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Tier</th>
                    <th scope="col">Prompt</th>
                    <th scope="col">Completion</th>
                    <th scope="col">Cache read</th>
                    <th scope="col">Cache write</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={scenario().rateSets}>
                    {(rate) => (
                      <tr>
                        <th scope="row">
                          {rate.tierID}
                          {rate.minPromptTokens === null
                            ? ""
                            : ` · >${rate.minPromptTokens.toLocaleString()} prompt tokens`}
                          {rate.utcStart === null && rate.utcEnd === null
                            ? ""
                            : ` · UTC selector ${rate.utcStart ?? "start not set"}–${rate.utcEnd ?? "end not set"}`}
                        </th>
                        <td>{rate.prompt ?? "Unavailable"}</td>
                        <td>{rate.completion ?? "Unavailable"}</td>
                        <td>{rate.cacheRead ?? "Unavailable"}</td>
                        <td>{rate.cacheWrite ?? "Unavailable"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={!scenario().rateSets.length}>
                <p>No compatible endpoint rate sets are available; unavailable is not zero.</p>
              </Show>
            </div>
          </div>
        </div>
      </details>
    </section>
  )
}

function estimateLabel(
  inspection: Extract<
    NonNullable<ModelComparisonPanelData["decisionInspection"]>,
    { status: "found" }
  >["estimate"],
) {
  const estimate = inspection
  if (estimate.status === "zero-accepted") return "No accepted tasks; estimate unavailable."
  if (estimate.status === "unknown") return "Estimate unavailable."
  if (estimate.status === "single-observation")
    return "Empirical observed value · n=1 accepted logical-task history"
  if (estimate.status === "partial")
    return `Partial empirical observed spread · n=${estimate.observationCount}`
  return `Empirical observed spread · n=${estimate.observationCount} accepted logical-task histories`
}

function estimateValuesLabel(
  inspection: Extract<
    NonNullable<ModelComparisonPanelData["decisionInspection"]>,
    { status: "found" }
  >["estimate"],
) {
  const estimate = inspection
  if (estimate.status === "zero-accepted") return "No successful-task estimate is available."
  if (estimate.status === "unknown") return "No complete estimate basis is available."
  const tokenRange = estimate.range.tokens
  const priceRange = estimate.range.currentMarketUSD
  const renderRange = (range: { minimum: number; maximum: number } | null) => {
    if (!range) return "Unknown"
    return range.minimum === range.maximum
      ? formatNumber(range.minimum)
      : `${formatNumber(range.minimum)}–${formatNumber(range.maximum)}`
  }
  const price = priceRange
    ? `${formatMoney(priceRange.minimum)}${priceRange.maximum === priceRange.minimum ? "" : `–${formatMoney(priceRange.maximum)}`}`
    : "current market cost unknown"
  const single = estimate.status === "single-observation" ? " · one value, no interval" : ""
  const missing = estimate.status === "partial" ? ` · missing ${estimate.missing.join(", ")}` : ""
  return `${renderRange(tokenRange)} tokens · ${price}${single}${missing}`
}

function estimateUnavailableReason(
  estimate: Extract<
    NonNullable<ModelComparisonPanelData["decisionInspection"]>,
    { status: "found" }
  >["estimate"],
) {
  return estimate.status === "unknown" ? estimate.reason : undefined
}

function estimateHistoryScopeLabel(
  estimate: Extract<
    NonNullable<ModelComparisonPanelData["decisionInspection"]>,
    { status: "found" }
  >["estimate"],
) {
  const historyScope = estimate.historyScope
  const completeness =
    historyScope?.completeness === "complete-accepted-logical-task-retry-history"
      ? "Complete accepted-task retry history"
      : "Accepted-task retry-history completeness unknown"
  return `${completeness} · Route scope · ${historyScope?.routeScope ?? "unknown"}`
}

function estimateHistoryDescription(
  estimate: Extract<
    NonNullable<ModelComparisonPanelData["decisionInspection"]>,
    { status: "found" }
  >["estimate"],
) {
  const historyIsComplete =
    estimate.historyScope?.completeness === "complete-accepted-logical-task-retry-history"
  return historyIsComplete
    ? "The producer reports complete accepted-task histories, including retries. This is observed spread, not a predictive interval."
    : "Accepted-task retry-history completeness is unknown. This is observed spread, not a predictive interval."
}

function contributorMembershipLabel(
  membership: "cohort-effort" | "empirical-history" | "both" | undefined,
) {
  switch (membership) {
    case "cohort-effort":
      return "cohort-effort"
    case "empirical-history":
      return "history-only"
    case "both":
      return "both"
    default:
      return "unknown"
  }
}

function variantCoverageLabel(candidate: ModelCandidate) {
  const variants = candidate.native.availableVariants
  const coverage = candidate.native.variantCoverage
  const labels = variants?.length ? variants.join(", ") : "None reported"

  if (coverage.status === "truncated")
    return `Variants (${formatNumber(variants?.length)} shown of ${formatNumber(coverage.totalVariants)} total; ${formatNumber(coverage.omittedVariants)} omitted): ${labels}`
  if (coverage.status === "complete")
    return `Variants (${formatNumber(coverage.totalVariants)} total): ${labels}`
  return `Variants (coverage unknown): ${variants?.join(", ") || "Not reported"}`
}

function sourceRefreshLabel(data: ModelComparisonPanelData) {
  if (data.sourceRefresh === "refreshing") return "Refreshing sources…"
  if (data.sourceRefresh === "failed") return "Source refresh failed; showing saved data."
  if (data.sourceRefresh === "succeeded") return "Sources refreshed."
  return "Showing saved data."
}

function statusText(status: string) {
  switch (status) {
    case "observed":
      return "Observed"
    case "partial":
      return "Partial"
    case "missing":
      return "Missing"
    case "unavailable":
      return "Unavailable"
    default:
      return status
  }
}

function ModelPanel(
  props: PanelProps & {
    ctx: ModelsContext
    openTrajectory: TaskTrajectoryOpener
  },
) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<ModelComparisonPanelData>(
    new ModelComparisonPanelState(() => {}).data,
  )
  const [split, setSplit] = createSignal(initial.split)
  const [chartHeight, setChartHeight] = createSignal<number>()
  const [assignmentPersona, setAssignmentPersona] = createSignal<WorkerPersona | null>(null)
  const [assignmentScope, setAssignmentScope] =
    createSignal<ModelMappingTargetInput["scope"]>("task")
  const [assignmentRoute, setAssignmentRoute] = createSignal({
    providerID: "",
    id: "",
    variant: "",
  })
  // A route carried from Compare into the Assignments editor draft for one persona.
  const [assignmentPrefill, setAssignmentPrefill] = createSignal<{
    persona: WorkerPersona
    route: { providerID: string; id: string; variant: string }
    version: number
  }>()
  let assignmentPickerRequest = 0
  let root: HTMLDivElement | undefined
  let topPane: HTMLDivElement | undefined
  let header: HTMLElement | undefined
  let comparison: HTMLElement | undefined
  let inspector: HTMLDivElement | undefined
  let endDrag: (() => void) | undefined

  const locationRequest = createMemo(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        lookup: Symbol("models-location"),
        client: props.session.server.client,
        server: props.session.server.id,
        session: props.session.id,
        directory: props.session.directory,
      }
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.client === next?.client &&
        previous?.server === next?.server &&
        previous?.session === next?.session &&
        previous?.directory === next?.directory,
    },
  )
  const source = createLatest(locationRequest, async (value, signal) => {
    const location = await value.client.location.get(
      { location: { directory: value.directory } },
      { signal },
    )
    return {
      ...value,
      project: location.project.canonical,
      projectID: location.project.id,
    }
  })
  const current = () => {
    const request = locationRequest()
    if (!request) return undefined
    const value = source.latest
    return value &&
      value.lookup === request.lookup &&
      value.server === props.session.server.id &&
      value.session === props.session.id &&
      value.directory === props.session.directory
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.modelsView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  const save = (change: Partial<typeof initial>) => {
    const value = current()
    if (!value) return
    ctx.stores.modelsView(props.session).update((draft) => {
      draft.projects[value.project] = {
        ...(draft.projects[value.project] ?? initial),
        ...change,
      }
    })
  }
  const state = new ModelComparisonPanelState(setData, (selection) =>
    save({
      selectedTaskID: selection.selectedTaskID,
      selectedCandidateID: selection.selectedCandidateID,
      selectedConfigurationID: selection.selectedConfigurationID,
    }),
  )
  const expectedKey = () => {
    const value = current()
    return value
      ? JSON.stringify([
          value.server,
          value.projectID,
          value.project,
          value.session,
          value.directory,
        ])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)

  onCleanup(() => {
    assignmentPickerRequest++
    state.close()
    endDrag?.()
  })

  createKeyed(
    () => {
      const value = current()
      if (!value || !ctx.stores.modelsView(props.session).ready()) return undefined
      return { value, key: expectedKey() }
    },
    ({ value, key }) => {
      const view = prefs()
      setSplit(clampSplit(view.split))
      const models = value.client.rpc(Models)
      const decisions = value.client.rpc(ModelsDecision)
      const tasks = value.client.rpc(Tasks)
      const observations = value.client.rpc(Observability)
      const location = { location: { directory: value.directory } }
      const transport: ModelComparisonTransport = {
        comparison: (cursor, signal) =>
          models.comparison(
            {
              sessionID: value.session,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
            { ...location, signal },
          ),
        refreshSources: (signal) =>
          models.refreshSources({ sessionID: value.session }, { ...location, signal }),
        settings: (taskID, signal) =>
          models.settings(
            { sessionID: value.session, ...(taskID ? { taskID } : {}) },
            { ...location, signal },
          ),
        catalog: (signal) => models.catalog({ sessionID: value.session }, { ...location, signal }),
        configure: (update, signal) =>
          models.configure({ sessionID: value.session, ...update }, { ...location, signal }),
        queryTasks: (signal) =>
          tasks.query(
            { state: "all", includeCompleted: true, includeRetired: true, limit: 100 },
            { ...location, signal },
          ),
        getTask: (taskID, signal) => tasks.get({ taskID }, { ...location, signal }),
        trajectoryStatus: (taskID, signal) =>
          observations.trajectoryStatus(
            { scope: { kind: "project", sessionID: value.session }, taskID },
            { ...location, signal },
          ),
        decisionOverview: (filters, signal) =>
          decisions.overview(
            { sessionID: value.session, scope: { projectDirectory: value.project }, filters },
            { ...location, signal },
          ),
        decisionRows: (filters, cursor, snapshotID, signal) =>
          decisions.rows(
            {
              sessionID: value.session,
              scope: { projectDirectory: value.project },
              filters,
              limit: 50,
              snapshotID,
              ...(cursor ? { cursor } : {}),
            },
            { ...location, signal },
          ),
        decisionConfigurations: (filters, cursor, snapshotID, signal) =>
          decisions.configurations(
            {
              sessionID: value.session,
              scope: { projectDirectory: value.project },
              filters,
              limit: 50,
              snapshotID,
              ...(cursor ? { cursor } : {}),
            },
            { ...location, signal },
          ),
        decisionInspect: (
          filters,
          snapshotID,
          configurationID,
          selectedTaskID,
          contributorCursor,
          signal,
        ) =>
          decisions.inspect(
            {
              sessionID: value.session,
              scope: { projectDirectory: value.project },
              filters,
              snapshotID,
              configurationID,
              selectedTaskID,
              contributorLimit: 50,
              ...(contributorCursor ? { contributorCursor } : {}),
            },
            { ...location, signal },
          ),
        online: () => props.session.server.connected,
      }
      state.connect(
        key,
        value.projectID,
        value.project,
        transport,
        {
          selectedTaskID: view.selectedTaskID,
          selectedCandidateID: view.selectedCandidateID,
          selectedConfigurationID: view.selectedConfigurationID ?? null,
        },
        {
          persona: view.persona,
          taskKind: view.taskKind ?? null,
          period: { from: null, to: null },
        },
      )
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  createEffect(() => {
    const value = current()
    if (!value || !visible()) return
    if (topPane && topPane.scrollTop !== prefs().topScroll) topPane.scrollTop = prefs().topScroll
    if (inspector && inspector.scrollTop !== prefs().inspectorScroll)
      inspector.scrollTop = prefs().inspectorScroll
  })

  // Size the plot from the space left in the top pane. Chart data and the legend sit
  // below the plot, so opening them scrolls the pane instead of shrinking the plot.
  const fitChart = () => {
    const plot = topPane?.querySelector<HTMLElement>(".lazers-models-comparison-chart-plot")
    if (!topPane || !plot || topPane.clientHeight <= 0 || !plot.getClientRects().length) return
    const offset =
      plot.getBoundingClientRect().top - topPane.getBoundingClientRect().top + topPane.scrollTop
    const next = Math.round(
      Math.min(
        chartHeightBounds.maximum,
        Math.max(chartHeightBounds.minimum, topPane.clientHeight - offset - chartFooterReserve),
      ),
    )
    if (next !== chartHeight()) setChartHeight(next)
  }
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => fitChart())
    for (const element of [topPane, header, comparison]) if (element) observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  const selectedCandidate = () => {
    const configuration = selectedDecisionConfiguration()
    if (!configuration) return undefined
    return visible()?.candidates.find(
      (candidate) =>
        candidate.identity.providerID === configuration?.route.providerID &&
        candidate.identity.modelID === configuration.route.modelID &&
        candidate.identity.variant === configuration.route.variant,
    )
  }
  const decisionDisplayRoutes = () => [
    ...availableConfigurations().map((configuration) => ({
      ...configuration.route,
      variant: null,
    })),
    ...(visible()?.decisionOverview?.graph.referenceEstimates ?? []).map((reference) => ({
      ...reference.estimate.route,
      variant: null,
    })),
  ]
  const decisionModelFullName = (configuration: ModelDecisionConfiguration) =>
    modelDisplayLabel(
      configuration.route,
      decisionDisplayRoutes(),
      visible()?.candidates ?? [],
      visible()?.catalog?.options ?? [],
    )
  const decisionModelLabel = (configuration: ModelDecisionConfiguration) =>
    boundedModelLabel(decisionModelFullName(configuration))
  const decisionModelChoiceLabel = (configuration: ModelDecisionConfiguration) => {
    const friendly = decisionModelFullName(configuration)
    const exactRoute = routeLabel(configuration.route)
    return friendly.includes(exactRoute) ? friendly : `${friendly} · ${exactRoute}`
  }
  const selectedTask = () => visible()?.task
  const selectedDecisionConfiguration = () => {
    const current = visible()
    if (!current?.selectedConfigurationID) return undefined
    return (
      current.decisionInspection?.configuration ??
      current.decisionConfigurations.find(
        (configuration) => configuration.configurationID === current.selectedConfigurationID,
      ) ??
      current.decisionRows.find(
        (row) => row.configuration.configurationID === current.selectedConfigurationID,
      )?.configuration
    )
  }
  const selectedMarketEstimate = () => {
    const inspection = visible()?.decisionInspection
    if (!inspection || inspection.status !== "found") return undefined
    const context = inspection.context
    const freshness =
      visible()?.stale ||
      visible()?.comparisonStale ||
      visible()?.decisionStatus === "stale" ||
      context.freshness === "stale"
        ? "stale"
        : context.priceIndex.freshness
    return currentMarketEstimateSummary({
      estimate: inspection.estimate,
      referenceEstimate: inspection.referenceEstimate,
      acceptedTaskCount: inspection.cohort.acceptedTaskCount,
      priceSource: context.priceIndex.source,
      priceFreshness: freshness,
    })
  }
  /** Two-line summary: model · effort above, rounded cost · sample size · source below. */
  const selectedSummaryLine = () => {
    const inspection = visible()?.decisionInspection
    if (!inspection || inspection.status !== "found") return undefined
    const count = inspection.cohort.acceptedTaskCount
    const tasks = `from ${count} task${count === 1 ? "" : "s"}`
    const summary = selectedMarketEstimate()
    // No applicable price: omit the cost rather than label it unavailable.
    if (!summary)
      return count > 0
        ? { text: `From ${count} task${count === 1 ? "" : "s"}`, title: `${count} accepted tasks` }
        : undefined
    return {
      text: `${summary.amount} · ${tasks} · ${marketSummarySource(summary.context)}`,
      title: summary.title,
    }
  }
  const selectedContributors = () => {
    const inspection = visible()?.decisionInspection
    return inspection?.status === "found" ? inspection.contributorPage.contributors : []
  }
  type DecisionChartGraph = NonNullable<ModelComparisonPanelData["decisionOverview"]>["graph"]
  let chartReferencePoints: DecisionChartGraph["points"] | undefined
  let chartReferenceEstimates: DecisionChartGraph["referenceEstimates"] | undefined
  let chartReferenceCandidates: ModelComparisonPanelData["candidates"] | undefined
  let chartReferenceCatalog: ModelCatalogOutput["options"] | undefined
  let chartReferences: ComparisonChartReference[] = []
  const decisionChartReferences = createMemo(() => {
    const current = visible()
    const graph = current?.decisionOverview?.graph
    if (!graph) return []

    const candidates = current.candidates
    const catalogOptions = current.catalog?.options
    if (
      chartReferencePoints === graph.points &&
      chartReferenceEstimates === graph.referenceEstimates &&
      chartReferenceCandidates === candidates &&
      chartReferenceCatalog === catalogOptions
    )
      return chartReferences

    const points = new Map(graph.points.map((point) => [point.configurationID, point] as const))
    const catalog = catalogOptions ?? []
    const routes = (graph.referenceEstimates ?? []).map((item) => item.estimate.route)
    chartReferencePoints = graph.points
    chartReferenceEstimates = graph.referenceEstimates
    chartReferenceCandidates = candidates
    chartReferenceCatalog = catalogOptions
    chartReferences = (graph.referenceEstimates ?? []).map((item) => {
      const point = points.get(item.configurationID)
      return {
        configurationID: item.configurationID,
        estimate: item.estimate,
        // An explicit null is authoritative: never replace unknown global data
        // with a number or label discovered on a loaded page or inspection.
        tokensPerAcceptedTask: Object.hasOwn(item, "tokensPerAcceptedTask")
          ? (item.tokensPerAcceptedTask ?? null)
          : (point?.tokensPerAcceptedTask ?? null),
        label: modelDisplayLabel(item.estimate.route, routes, candidates, catalog),
      }
    })
    return chartReferences
  })
  let chartPointSource: DecisionChartGraph["points"] | undefined
  let chartPointReferences: ComparisonChartReference[] | undefined
  let chartPointCandidates: ModelComparisonPanelData["candidates"] | undefined
  let chartPointCatalog: ModelCatalogOutput["options"] | undefined
  let chartPointMarketSource:
    | NonNullable<ModelComparisonPanelData["decisionOverview"]>["context"]["priceIndex"]["source"]
    | undefined
  let chartPoints: ComparisonChartPoint[] = []
  const decisionChartPoints = createMemo(() => {
    const current = visible()
    const overview = current?.decisionOverview
    if (!overview) return []
    const references = decisionChartReferences()
    const candidates = current.candidates
    const catalogOptions = current.catalog?.options
    const marketSource = overview.context.priceIndex.source
    if (
      chartPointSource === overview.graph.points &&
      chartPointReferences === references &&
      chartPointCandidates === candidates &&
      chartPointCatalog === catalogOptions &&
      chartPointMarketSource === marketSource
    )
      return chartPoints

    const routeByConfiguration = new Map(
      references.map((reference) => [reference.configurationID, reference.estimate.route] as const),
    )
    const routes = references.map((reference) => reference.estimate.route)
    const catalog = catalogOptions ?? []
    chartPointSource = overview.graph.points
    chartPointReferences = references
    chartPointCandidates = candidates
    chartPointCatalog = catalogOptions
    chartPointMarketSource = marketSource
    chartPoints = overview.graph.points.map((point) => {
      const route = routeByConfiguration.get(point.configurationID)
      return {
        ...point,
        ...(route
          ? {
              label: modelDisplayLabel(route, routes, candidates, catalog),
              route,
            }
          : {}),
        marketSource,
      }
    })
    return chartPoints
  })
  const availableConfigurations = (): ModelDecisionConfiguration[] => {
    const current = visible()
    if (!current) return []
    const all = [
      ...current.decisionConfigurations,
      ...current.decisionRows.map((row) => row.configuration),
      ...(current.decisionInspection ? [current.decisionInspection.configuration] : []),
    ]
    const seen = new Set<string>()
    return all.filter((configuration) => {
      if (seen.has(configuration.configurationID)) return false
      seen.add(configuration.configurationID)
      return true
    })
  }
  const configurationsForGroup = (groupID: string) =>
    availableConfigurations().filter((configuration) => configuration.groupID === groupID)
  const providerChoices = () => {
    const groupByID = new Map<string, ModelDecisionConfiguration>()
    for (const configuration of availableConfigurations())
      if (!groupByID.has(configuration.groupID)) groupByID.set(configuration.groupID, configuration)
    return [...groupByID.values()]
  }
  // Public benchmark baseline. Units (Coding Index vs list price per 1M tokens) differ
  // from observed cost per task, so it is a separate chart mode, never a shared frontier.
  const [priceSourceRevision, setPriceSourceRevision] = createSignal(0)
  const priceSourceRequest = createMemo(
    () => {
      const value = current()
      return value ? { value, revision: priceSourceRevision() } : undefined
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.value === next?.value && previous?.revision === next?.revision,
    },
  )
  const priceSourceSettings = createLatest(priceSourceRequest, async ({ value }, signal) => {
    try {
      const settings = await value.client
        .rpc(Models)
        .priceSources(
          { sessionID: value.session },
          { location: { directory: value.directory }, signal },
        )
      return { value, sources: settings.policy.sources, configured: true }
    } catch {
      return { value, sources: [...MODEL_PRICE_SOURCES], configured: false }
    }
  })
  /** Configured price source order; the documented default until it is read. */
  const priceSourceOrder = (): { sources: ModelPriceSource[]; configured: boolean } => {
    const latest = priceSourceSettings.latest
    return latest && latest.value === current()
      ? latest
      : { sources: [...MODEL_PRICE_SOURCES], configured: false }
  }
  const comparisonSource = (
    source: "native-catalog" | "openrouter-models" | "openrouter-benchmarks",
  ) => visible()?.comparison?.sources.find((entry) => entry.source === source)
  const observedRouteKeys = createMemo(
    () =>
      new Set([
        ...availableConfigurations().map((configuration) => routeKey(configuration.route)),
        ...decisionChartReferences().map((reference) => routeKey(reference.estimate.route)),
      ]),
  )
  const baseline = createMemo(() => {
    const panel = visible()
    if (!panel) return undefined
    const candidates = panel.candidates
    const routes = candidates.map((candidate) => ({ ...candidate.identity, variant: null }))
    const catalog = panel.catalog?.options ?? []
    return benchmarkBaseline({
      candidates,
      priceSources: priceSourceOrder().sources,
      sourceDates: {
        openrouter: comparisonSource("openrouter-models")?.snapshot?.retrievedAt ?? null,
        opencode: comparisonSource("native-catalog")?.snapshot?.retrievedAt ?? null,
      },
      observedRoutes: observedRouteKeys(),
      label: (route) => modelDisplayLabel({ ...route, variant: null }, routes, candidates, catalog),
    })
  })
  const observedPlottedModels = () =>
    comparisonChartKeyboardOrder(decisionChartPoints(), decisionChartReferences()).length
  /** Benchmark leads only when observations are sparse and the baseline has data. */
  const compareMode = (): "observed" | "benchmark" => {
    const chosen = prefs().compareMode
    if (chosen) return chosen
    if (!visible()?.decisionOverview) return "observed"
    return observedPlottedModels() < 2 && (baseline()?.points.length ?? 0) > 0
      ? "benchmark"
      : "observed"
  }
  const selectCompareMode = (mode: "observed" | "benchmark") => save({ compareMode: mode })
  const compareModeKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const next = compareMode() === "observed" ? "benchmark" : "observed"
    selectCompareMode(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-compare-mode="${next}"]`)
      ?.focus()
  }
  const observedScopeLabel = () => {
    const filters = visible()?.decisionFilters
    const scope = [
      filters?.persona ? modelPersonaLabels[filters.persona] : null,
      filters?.taskKind ? modelTaskKindLabels[filters.taskKind] : null,
    ].filter(Boolean)
    return scope.length ? `Observed for ${scope.join(" · ")}` : "Observed in this project"
  }
  const benchmarkPriceSourceLabel = () => {
    const used = new Set(baseline()?.points.map((point) => point.price.source) ?? [])
    const names = priceSourceOrder()
      .sources.filter((source) => used.has(source))
      .map((source) => benchmarkSourceName[source])
    return names.length ? names.join(" / ") : "Catalog"
  }
  const benchmarkAsOf = () => {
    const snapshot = comparisonSource("openrouter-benchmarks")?.snapshot
    const date = snapshot?.asOf ?? snapshot?.retrievedAt
    return date ? formatDate(date) : undefined
  }
  const benchmarkEmptyText = () => {
    const source = comparisonSource("openrouter-benchmarks")
    const current = baseline()
    if (!source?.snapshot)
      return "Public benchmark data hasn't been retrieved. It needs OpenRouter access configured in OpenCode; Refresh retries."
    if (!current || current.points.length + current.gaps.length === 0)
      return `None of the ${new Set(visible()?.candidates.map((candidate) => routeKey(candidate.identity))).size} loaded catalog models match a public benchmark yet.`
    return "Benchmarked models have no applicable list price from the configured price sources."
  }
  const selectedBenchmark = () => {
    const current = baseline()
    const selectedID = visible()?.selectedCandidateID
    if (!current || !selectedID) return undefined
    const candidate = visible()?.candidates.find((entry) => entry.candidateID === selectedID)
    const key = candidate ? routeKey(candidate.identity) : undefined
    return (
      current.points.find((point) => point.id === selectedID || routeKey(point.route) === key) ??
      current.gaps.find((gap) => gap.id === selectedID || routeKey(gap.route) === key)
    )
  }
  const observedConfigurationFor = (route: BenchmarkRoute) =>
    availableConfigurations().find(
      (configuration) =>
        configuration.route.providerID === route.providerID &&
        configuration.route.modelID === route.modelID,
    )
  const showObservedFor = (route: BenchmarkRoute) => {
    const configuration = observedConfigurationFor(route)
    selectCompareMode("observed")
    if (configuration) state.selectConfiguration(configuration.configurationID)
  }
  const changeDecisionFilters = (change: Partial<ModelDecisionFilters>) => {
    const current = visible()?.decisionFilters ?? emptyModelDecisionFilters
    const next: ModelDecisionFilters = {
      ...current,
      ...change,
      period: current.period,
    }
    save({ persona: next.persona, taskKind: next.taskKind })
    state.setDecisionFilters(next)
  }
  const selectDecisionGroup = (groupID: string) => {
    const configurations = configurationsForGroup(groupID)
    const current = selectedDecisionConfiguration()
    const next =
      configurations.find(
        (configuration) => configuration.configurationID === current?.configurationID,
      ) ?? configurations[0]
    if (next) state.selectConfiguration(next.configurationID)
    else {
      const point = visible()?.decisionOverview?.graph.points.find(
        (entry) => entry.groupID === groupID,
      )
      if (point) state.selectConfiguration(point.configurationID)
    }
  }
  const taskLabel = () => {
    const task = selectedTask()
    return task ? task.reference : visible()?.selectedTaskID ? "Task unavailable" : "Choose task"
  }
  const taskDescription = () => {
    const task = selectedTask()
    return task
      ? `${task.reference} · ${task.task.id} · ${task.task.proposal.objective}`
      : (visible()?.selectedTaskID ?? "Choose a task for comparison")
  }
  const projectLabel = () => current()?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"
  const personas = () => visible()?.settings?.personas ?? []
  const assignmentSettings = () =>
    personas().find((persona) => persona.persona === assignmentPersona())
  const assignmentLayer = () => assignmentSettings()?.layers[assignmentScope()] ?? null
  const catalogOptions = () =>
    (visible()?.catalog?.options ?? []).filter((option) => option.enabled !== false)
  const selectedCatalogModel = () =>
    catalogOptions().find(
      (option) =>
        option.providerID === assignmentRoute().providerID && option.id === assignmentRoute().id,
    )
  const catalogOptionKey = (
    option: Pick<ModelCatalogOutput["options"][number], "providerID" | "id">,
  ) => JSON.stringify([option.providerID, option.id])
  const modelSelectionCaption = () => {
    const model = selectedCatalogModel()
    if (model) return `${model.providerID} / ${model.id}`
    const route = assignmentRoute()
    return route.providerID && route.id
      ? `Not in catalog · ${route.providerID} / ${route.id}`
      : "Choose a model from the native catalog"
  }
  const modelPickerButtonLabel = () => {
    const model = selectedCatalogModel()
    return model
      ? `${model.name || model.id} · ${model.providerID}`
      : assignmentRoute().providerID && assignmentRoute().id
        ? "Custom route"
        : "Choose model"
  }
  const assignmentVariantChoices = () => selectedCatalogModel()?.variants ?? []
  const assignmentVariantLabel = () => assignmentRoute().variant || "No variant"
  const assignmentEditorTitleID = () =>
    `lazers-models-assignment-editor-title-${encodeURIComponent(visible()?.key ?? "panel")}`
  const assignmentScopeLabel = (scope: ModelMappingTargetInput["scope"]) =>
    scope === "shared"
      ? "Shared default"
      : scope === "project"
        ? "Project override"
        : "Task override"
  const clearConfirmedAssignmentWrite = () => state.clearConfirmedAssignmentWrite()
  const selectAssignmentPersona = (persona: WorkerPersona) => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentPrefill(undefined)
    setAssignmentPersona(persona)
  }
  const selectAssignmentScope = (scope: ModelMappingTargetInput["scope"]) => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentScope(scope)
  }
  const updateAssignmentRoute = (change: Partial<ReturnType<typeof assignmentRoute>>) => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentRoute((previous) => ({ ...previous, ...change }))
  }
  const assignmentWrite = () => visible()?.assignmentWrite
  const assignmentBusy = () =>
    assignmentWrite()?.status === "saving" || assignmentWrite()?.status === "verifying"
  const assignmentBlocked = () =>
    assignmentBusy() ||
    assignmentWrite()?.status === "uncertain" ||
    assignmentWrite()?.status === "conflict" ||
    assignmentWrite()?.status === "failed"
  const assignmentCanSave = () => {
    const route = assignmentRoute()
    return Boolean(
      assignmentPersona() &&
      visible()?.settings &&
      !visible()?.settingsLoading &&
      !visible()?.settingsError &&
      !(assignmentScope() === "task" && !visible()?.selectedTaskID) &&
      route.providerID.trim() &&
      route.id.trim() &&
      !assignmentBlocked(),
    )
  }
  let lastAssignmentDraftKey = ""
  createEffect(() => {
    const panel = visible()
    const persona = assignmentPersona()
    const scope = assignmentScope()
    const setting = assignmentSettings()
    const prefill = assignmentPrefill()
    if (!panel?.settings || !persona || !setting) {
      lastAssignmentDraftKey = ""
      return
    }
    const layer = setting.layers[scope]
    const carried = prefill?.persona === persona ? prefill : undefined
    const key = `${panel.key}:${panel.settings.taskID ?? "project"}:${persona}:${scope}:${layer?.revision ?? 0}:${carried?.version ?? 0}`
    if (key === lastAssignmentDraftKey) return
    lastAssignmentDraftKey = key
    setAssignmentRoute(
      carried?.route ?? {
        providerID: layer?.route?.providerID ?? "",
        id: layer?.route?.id ?? "",
        variant: layer?.route?.variant ?? "",
      },
    )
  })
  const saveAssignmentRoute = () => {
    const persona = assignmentPersona()
    if (!persona || !assignmentCanSave()) return
    const draft = assignmentRoute()
    const route: ModelPolicy = {
      providerID: draft.providerID,
      id: draft.id,
      ...(draft.variant.length ? { variant: draft.variant } : {}),
    }
    void state.configureMapping(persona, assignmentScope(), route)
  }
  const removeAssignmentRoute = () => {
    const persona = assignmentPersona()
    if (!persona || !assignmentLayer()?.route || assignmentBlocked()) return
    setAssignmentPrefill(undefined)
    void state.configureMapping(persona, assignmentScope(), null)
  }
  const assignmentLayerLabel = (
    label: string,
    layer: NonNullable<ReturnType<typeof assignmentSettings>>["layers"]["task"],
  ) => {
    if (!layer) return `${label}: Not set`
    if (!layer.route) return `${label}: Removed · revision ${layer.revision}`
    return `${label}: ${routeLabel({
      providerID: layer.route.providerID,
      modelID: layer.route.id,
      variant: layer.route.variant ?? null,
    })} · revision ${layer.revision}`
  }
  const openAssignmentModelPicker = async () => {
    const panel = visible()
    const persona = assignmentPersona()
    if (
      !panel ||
      !persona ||
      assignmentBlocked() ||
      panel.catalogStatus !== "ready" ||
      !catalogOptions().length
    )
      return

    const scope = assignmentScope()
    const taskID = panel.selectedTaskID
    const panelKey = panel.key
    const options = catalogOptions()
    const request = ++assignmentPickerRequest
    const selectedOption = selectedCatalogModel()
    let chosenKey: string | undefined
    try {
      chosenKey = await ctx.dialogs.select({
        title: "Choose a model",
        placeholder: "Search model name, provider, or ID",
        current: selectedOption ? catalogOptionKey(selectedOption) : undefined,
        options: options.map((option) => ({
          title: option.name || option.id,
          value: catalogOptionKey(option),
          group: option.providerID,
          description: `${option.providerID} ${option.id}${option.type ? ` · ${option.type}` : ""}`,
        })),
      })
    } catch {
      return
    }

    const currentPanel = visible()
    if (
      chosenKey === undefined ||
      request !== assignmentPickerRequest ||
      assignmentBlocked() ||
      currentPanel?.key !== panelKey ||
      currentPanel.selectedTaskID !== taskID ||
      assignmentPersona() !== persona ||
      assignmentScope() !== scope
    )
      return

    const option = options.find((candidate) => catalogOptionKey(candidate) === chosenKey)
    if (!option) return
    const previous = assignmentRoute()
    const sameModel = previous.providerID === option.providerID && previous.id === option.id
    updateAssignmentRoute({
      providerID: option.providerID,
      id: option.id,
      variant: sameModel ? previous.variant : "",
    })
  }
  const AssignmentEditor = () => (
    <Show when={assignmentSettings()}>
      {(persona) => (
        <section
          class="lazers-models-assignment-editor"
          aria-labelledby={assignmentEditorTitleID()}
        >
          <header class="lazers-models-assignment-editor-heading">
            <div>
              <h3 id={assignmentEditorTitleID()}>Edit {persona().personaLabel}</h3>
              <p>Exact native route</p>
            </div>
            <Ui.Menu
              label={`Target · ${assignmentScopeLabel(assignmentScope())}`}
              trigger="button"
              icon="chevron-down"
              disabled={assignmentBlocked()}
              items={[
                { label: "Shared default", onSelect: () => selectAssignmentScope("shared") },
                { label: "Project override", onSelect: () => selectAssignmentScope("project") },
                { label: "Task override", onSelect: () => selectAssignmentScope("task") },
              ]}
            />
          </header>
          <Show when={assignmentScope() === "task" && !visible()?.selectedTaskID}>
            <p class="lazers-models-note" role="status">
              Choose a task from the toolbar before editing a task override.
            </p>
          </Show>
          <Show when={visible()?.catalogStatus === "loading"}>
            <p class="lazers-models-catalog-status" role="status">
              <Ui.Loader size="small" /> Loading native models…
            </p>
          </Show>
          <Show when={visible()?.catalogStatus === "unavailable"}>
            <div class="lazers-models-catalog-status" role="status">
              <span>Model catalog unavailable. Custom routes remain available.</span>
              <Ui.Button
                size="small"
                variant="ghost-muted"
                onClick={() => void state.refreshCatalog()}
              >
                Retry catalog
              </Ui.Button>
              <details class="lazers-models-catalog-error">
                <summary>Catalog details</summary>
                <p>{visible()?.catalogError}</p>
              </details>
            </div>
          </Show>
          <Show when={visible()?.catalogStatus === "ready" && !catalogOptions().length}>
            <p class="lazers-models-catalog-status" role="status">
              No models are listed. Custom routes remain available.
            </p>
          </Show>
          <div class="lazers-models-assignment-fields">
            <div class="lazers-models-assignment-choice">
              <span>Model</span>
              <Ui.Button
                size="small"
                disabled={
                  assignmentBlocked() ||
                  visible()?.catalogStatus !== "ready" ||
                  !catalogOptions().length
                }
                onClick={() => void openAssignmentModelPicker()}
              >
                {modelPickerButtonLabel()}
              </Ui.Button>
              <small>{modelSelectionCaption()}</small>
            </div>
            <div class="lazers-models-assignment-choice">
              <span>Effort / variant</span>
              <Ui.Menu
                label={`Effort · ${assignmentVariantLabel()}`}
                trigger="button"
                icon="chevron-down"
                disabled={assignmentBlocked() || !selectedCatalogModel()}
                items={[
                  { label: "No variant", onSelect: () => updateAssignmentRoute({ variant: "" }) },
                  ...assignmentVariantChoices().map((variant) => ({
                    label: variant,
                    onSelect: () => updateAssignmentRoute({ variant }),
                  })),
                ]}
              />
              <small>
                {selectedCatalogModel()
                  ? `For ${selectedCatalogModel()!.name || selectedCatalogModel()!.id}`
                  : "Custom variants can be entered below"}
              </small>
            </div>
          </div>
          <details class="lazers-models-assignment-manual-route">
            <summary>Custom route (manual IDs)</summary>
            <p>Use exact IDs when a route is missing from the native catalog.</p>
            <div class="lazers-models-assignment-manual-fields">
              <div class="lazers-models-assignment-field">
                <span>Provider ID</span>
                <Ui.TextInput
                  label="Provider ID"
                  value={assignmentRoute().providerID}
                  onInput={(providerID) => updateAssignmentRoute({ providerID })}
                  disabled={assignmentBlocked()}
                />
              </div>
              <div class="lazers-models-assignment-field">
                <span>Model ID</span>
                <Ui.TextInput
                  label="Model ID"
                  value={assignmentRoute().id}
                  onInput={(id) => updateAssignmentRoute({ id })}
                  disabled={assignmentBlocked()}
                />
              </div>
              <div class="lazers-models-assignment-field">
                <span>Variant / effort (optional)</span>
                <Ui.TextInput
                  label="Variant / effort (optional)"
                  value={assignmentRoute().variant}
                  onInput={(variant) => updateAssignmentRoute({ variant })}
                  disabled={assignmentBlocked()}
                />
              </div>
            </div>
          </details>
          <p class="lazers-models-assignment-current">
            <strong>Current override:</strong>{" "}
            {assignmentLayer()?.route
              ? routeLabel({
                  providerID: assignmentLayer()!.route!.providerID,
                  modelID: assignmentLayer()!.route!.id,
                  variant: assignmentLayer()!.route!.variant ?? null,
                })
              : assignmentLayer()
                ? "Removed"
                : "Not set"}
          </p>
          <div class="lazers-models-assignment-actions">
            <Ui.Button
              size="small"
              disabled={!assignmentCanSave()}
              busy={assignmentBusy()}
              onClick={saveAssignmentRoute}
            >
              Save route
            </Ui.Button>
            <Ui.Button
              size="small"
              variant="ghost-muted"
              disabled={!assignmentLayer()?.route || assignmentBlocked()}
              onClick={removeAssignmentRoute}
            >
              Remove override
            </Ui.Button>
          </div>
          <Show when={assignmentWrite()}>
            {(write) => {
              const alert = () => ["uncertain", "conflict", "failed"].includes(write().status)
              const statusLabel = () => {
                switch (write().status) {
                  case "saving":
                  case "verifying":
                    return "Saving…"
                  case "confirmed":
                    return "Saved"
                  case "uncertain":
                    return "Write unconfirmed"
                  case "conflict":
                    return "Updated elsewhere"
                  case "failed":
                    return "Could not save"
                }
              }
              const targetLabel = () => {
                const target = write().target
                if (!target) return "No target"
                return target.scope === "task"
                  ? `Task override · ${visible()?.settings?.projectDirectory ?? "current project"} · ${target.taskID}`
                  : target.scope === "project"
                    ? `Project override · ${visible()?.settings?.projectDirectory ?? "current project"}`
                    : assignmentScopeLabel(target.scope)
              }
              const requestRouteLabel = () => {
                const route = write().route
                return route
                  ? `${route.providerID} / ${route.id}${route.variant ? ` · ${route.variant}` : ""}`
                  : "remove override"
              }
              return (
                <div
                  class="lazers-models-assignment-feedback"
                  data-status={write().status}
                  role={alert() ? "alert" : "status"}
                  aria-live={alert() ? "assertive" : "polite"}
                >
                  <p>{statusLabel()}</p>
                  <Show when={write().status === "uncertain"}>
                    <Ui.Button
                      size="small"
                      variant="ghost-muted"
                      busy={assignmentBusy()}
                      onClick={() => void state.recheckAssignmentWrite()}
                    >
                      Check saved settings
                    </Ui.Button>
                  </Show>
                  <Show when={write().status === "conflict" || write().status === "failed"}>
                    <Ui.Button
                      size="small"
                      variant="ghost-muted"
                      busy={visible()?.settingsLoading}
                      onClick={() => void state.refreshSettings()}
                    >
                      Reload current settings
                    </Ui.Button>
                  </Show>
                  <details class="lazers-models-assignment-write-details">
                    <summary>Write details</summary>
                    <p>{write().message}</p>
                    <p>
                      {modelPersonaLabels[write().persona]} · {targetLabel()} · expected revision{" "}
                      {write().expectedRevision} · observed revision {write().revision ?? "unknown"}
                    </p>
                    <p>Requested route: {requestRouteLabel()}</p>
                  </details>
                </div>
              )
            }}
          </Show>
          <details class="lazers-models-assignment-layers">
            <summary>Mapping layers and revisions</summary>
            <p>{assignmentLayerLabel("Task override", persona().layers.task)}</p>
            <p>{assignmentLayerLabel("Project override", persona().layers.project)}</p>
            <p>{assignmentLayerLabel("Shared default", persona().layers.shared)}</p>
          </details>
        </section>
      )}
    </Show>
  )
  /** Technical reason behind the status chip; shown only inside a collapsed disclosure. */
  const decisionStatusDetail = () => {
    const panel = visible()
    if (!panel) return undefined
    if (panel.decisionError) return panel.decisionError
    return panel.decisionStatus === "backend-not-ready"
      ? panel.decisionContext?.unavailableReason
      : undefined
  }
  const sourceWarning = () => {
    const sources = visible()?.comparison?.sources ?? []
    if (sources.some((source) => source.refresh?.state === "failed"))
      return {
        message: "A price source couldn't refresh; showing saved data.",
        role: "alert" as const,
      }
    if (sources.some((source) => source.refresh?.state === "cancelled"))
      return {
        message: "Source refresh cancelled; showing saved data.",
        role: "status" as const,
      }
    if (sources.some((source) => source.storage !== "ready"))
      return {
        message: "Some source details are missing; model names may not match.",
        role: "status" as const,
      }
    if (sources.length && sources.some((source) => !source.snapshot))
      return { message: "Some sources have no saved data yet.", role: "status" as const }
    return undefined
  }
  const effortDetailsSummary = () => {
    const basis = visible()?.effortBasis
    if (!basis) return "Recorded task effort"
    const partial =
      basis.usage.coverage.missingSessions.length > 0 ||
      basis.usage.coverage.unavailableSessions.length > 0 ||
      basis.usage.coverage.progressTruncated
    return `${basis.attempts.count} recorded attempts · ${basis.usage.coverage.totalUniqueSessions} sessions · ${partial ? "partial coverage" : "coverage available"}`
  }

  const selectTab = (tab: Tab) => save({ tab })
  /** Open the Assignments editor for a persona with a compared route as an unsaved draft. */
  const assignRoute = (
    persona: WorkerPersona,
    route: { providerID: string; modelID: string; variant: string | null },
  ) => {
    if (assignmentBlocked()) return
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentPrefill((previous) => ({
      persona,
      route: { providerID: route.providerID, id: route.modelID, variant: route.variant ?? "" },
      version: (previous?.version ?? 0) + 1,
    }))
    setAssignmentPersona(persona)
    selectTab("assignments")
  }
  const assignSelectedRoute = (persona: WorkerPersona) => {
    const configuration = selectedDecisionConfiguration()
    if (configuration) assignRoute(persona, configuration.route)
  }
  const assignMenuItems = (route: () => BenchmarkRoute & { variant: string | null }) =>
    personas().map((persona) => ({
      label: persona.personaLabel,
      onSelect: () => assignRoute(persona.persona, route()),
    }))
  const assignDisabled = () =>
    !visible()?.settings || Boolean(visible()?.settingsLoading) || assignmentBlocked()
  const selectTask = (taskID: string) => {
    assignmentPickerRequest++
    state.selectTask(taskID)
  }
  const tabKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next: Tab =
      event.key === "Home"
        ? "compare"
        : event.key === "End"
          ? "assignments"
          : prefs().tab === "compare"
            ? "assignments"
            : "compare"
    selectTab(next)
    const targetID =
      next === "compare" ? "lazers-models-compare-tab" : "lazers-models-assignments-tab"
    topPane?.querySelector<HTMLButtonElement>(`#${targetID}`)?.focus()
  }

  const openSelectedTrajectory = () => {
    const task = selectedTask()
    const value = current()
    if (!task || !value) return
    const target: TaskTrajectoryRequest = {
      taskID: task.task.id,
      reference: task.reference,
      projectID: task.task.provenance.projectID,
      projectDirectory: value.project,
    }
    props.openTrajectory(props.session, target)
  }
  const openContributorTrajectory = (
    contributor: NonNullable<
      ModelComparisonPanelData["decisionInspection"]
    >["contributorPage"]["contributors"][number],
  ) => {
    const value = current()
    if (!value) return
    props.openTrajectory(props.session, {
      taskID: contributor.taskID,
      reference: contributor.taskReference,
      projectID: value.projectID,
      projectDirectory: value.project,
    })
  }

  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const bounds = root?.getBoundingClientRect()
      if (!bounds) return
      setSplit(clampSplit(((moveEvent.clientY - bounds.top) / bounds.height) * 100))
    }
    const end = () => {
      element.removeEventListener("pointermove", move)
      element.removeEventListener("pointerup", end)
      element.removeEventListener("pointercancel", end)
      if (expectedKey() === key) save({ split: split() })
      endDrag = undefined
    }
    element.addEventListener("pointermove", move)
    element.addEventListener("pointerup", end, { once: true })
    element.addEventListener("pointercancel", end, { once: true })
    endDrag = end
  }

  const categoryRows = [
    ["Uncached input", "uncachedInput"],
    ["Output", "output"],
    ["Reasoning", "reasoning"],
    ["Cache read", "cacheRead"],
    ["Cache write", "cacheWrite"],
  ] as const

  return (
    <div
      class="lazers-models"
      ref={(element) => {
        root = element
      }}
      style={{
        "--models-top-size": `${split()}%`,
        ...(chartHeight() ? { "--models-chart-height": `${chartHeight()}px` } : {}),
      }}
    >
      <div
        class="lazers-models-top"
        ref={(element) => {
          topPane = element
        }}
        onScroll={(event) => save({ topScroll: event.currentTarget.scrollTop })}
      >
        <header
          class="lazers-models-header"
          ref={(element) => {
            header = element
          }}
        >
          <div class="lazers-models-title-row">
            <h2>Models</h2>
            <span
              class="lazers-models-project"
              role="note"
              aria-label={`Project · ${current()?.project ?? "unavailable"}`}
              title={current()?.project}
            >
              Project · {projectLabel()}
            </span>
            <Ui.Button
              size="small"
              variant="ghost-muted"
              disabled={!visible() || visible()?.sourceRefresh === "refreshing"}
              busy={visible()?.sourceRefresh === "refreshing"}
              onClick={() => {
                setPriceSourceRevision((revision) => revision + 1)
                void state.refresh()
              }}
            >
              Refresh
            </Ui.Button>
          </div>
          <div class="lazers-models-tabs" role="tablist" aria-label="Models views">
            <button
              type="button"
              role="tab"
              id="lazers-models-compare-tab"
              aria-selected={prefs().tab === "compare"}
              aria-controls="lazers-models-compare-panel"
              tabIndex={prefs().tab === "compare" ? 0 : -1}
              onClick={() => selectTab("compare")}
              onKeyDown={tabKey}
            >
              Compare
            </button>
            <button
              type="button"
              role="tab"
              id="lazers-models-assignments-tab"
              aria-selected={prefs().tab === "assignments"}
              aria-controls="lazers-models-assignments-panel"
              tabIndex={prefs().tab === "assignments" ? 0 : -1}
              onClick={() => selectTab("assignments")}
              onKeyDown={tabKey}
            >
              Assignments
            </button>
          </div>
          <div class="lazers-models-controls">
            <div class="lazers-models-filters" role="group" aria-label="Comparison filters">
              <Ui.Menu
                label={`Persona · ${personaFilterLabel(visible()?.decisionFilters.persona ?? null)}`}
                trigger="button"
                icon="chevron-down"
                items={[
                  {
                    label: "All personas",
                    onSelect: () => changeDecisionFilters({ persona: null }),
                  },
                  ...(["ui", "systems", "small-refactoring"] as const).map((persona) => ({
                    label: modelPersonaLabels[persona],
                    onSelect: () => changeDecisionFilters({ persona }),
                  })),
                ]}
              />
              <Ui.Menu
                label={`Kind · ${visible()?.decisionFilters.taskKind ? modelTaskKindLabels[visible()!.decisionFilters.taskKind!] : "All"}`}
                trigger="button"
                icon="chevron-down"
                items={[
                  {
                    label: "All task kinds",
                    onSelect: () => changeDecisionFilters({ taskKind: null }),
                  },
                  ...modelTaskKinds.map((taskKind) => ({
                    label: modelTaskKindLabels[taskKind],
                    onSelect: () => changeDecisionFilters({ taskKind }),
                  })),
                ]}
              />
              <span
                class="lazers-models-task-select"
                role="group"
                aria-label={taskDescription()}
                title={taskDescription()}
              >
                <Ui.Menu
                  label={taskLabel()}
                  trigger="button"
                  icon="chevron-down"
                  disabled={!visible()?.tasks.length}
                  items={(visible()?.tasks ?? []).map((task) => ({
                    label: `${task.reference} · ${task.title || task.objective} · ${task.status}`,
                    onSelect: () => selectTask(task.taskID),
                  }))}
                />
              </span>
            </div>
            <Show when={compareMode() === "observed" ? selectedDecisionConfiguration() : undefined}>
              {(configuration) => (
                <div
                  class="lazers-models-selection-tools"
                  role="group"
                  aria-label="Model and effort selection"
                  title={`Exact route ${routeLabel(configuration().route)}`}
                >
                  <Ui.Menu
                    label={`Model · ${decisionModelLabel(configuration())}`}
                    trigger="button"
                    icon="chevron-down"
                    disabled={!providerChoices().length}
                    items={providerChoices().map((choice) => ({
                      label: decisionModelChoiceLabel(choice),
                      onSelect: () => selectDecisionGroup(choice.groupID),
                    }))}
                  />
                  <Ui.Menu
                    label={`Effort · ${configuration().route.variant ?? "Not specified"}`}
                    trigger="button"
                    icon="chevron-down"
                    disabled={!configurationsForGroup(configuration().groupID).length}
                    items={configurationsForGroup(configuration().groupID).map((choice) => ({
                      label: choice.route.variant ?? "Not specified",
                      onSelect: () => state.selectConfiguration(choice.configurationID),
                    }))}
                  />
                </div>
              )}
            </Show>
          </div>
          <Show when={visible()?.sourceRefresh === "refreshing"}>
            <p class="lazers-models-refresh-note" role="status">
              Refreshing sources…
            </p>
          </Show>
          <Show when={visible()?.sourceRefresh === "failed"}>
            <p class="lazers-models-error" role="alert">
              {sourceRefreshLabel(visible()!)}
            </p>
          </Show>
          <Show when={sourceWarning()}>
            {(warning) => (
              <p
                class={
                  warning().role === "alert" ? "lazers-models-error" : "lazers-models-refresh-note"
                }
                role={warning().role}
              >
                {warning().message}
              </p>
            )}
          </Show>
          <Show when={visible()?.comparisonStale}>
            <p class="lazers-models-refresh-note" role="status">
              Comparison is out of date; showing the last saved data.
            </p>
          </Show>
          <Show
            when={
              visible()?.stale &&
              !visible()?.comparisonStale &&
              visible()?.sourceRefresh !== "failed"
            }
          >
            <p class="lazers-models-refresh-note" role="status">
              Showing saved data; the latest couldn't be confirmed.
            </p>
          </Show>
          <Show when={!visible()?.comparison && visible()?.comparisonError}>
            <p class="lazers-models-error" role="alert">
              Comparison unavailable; refresh to retry.
            </p>
          </Show>
          <Show when={visible()?.tasksError}>
            <>
              <p class="lazers-models-error" role="alert">
                Task list unavailable.
              </p>
              <details class="lazers-models-warning-details">
                <summary>Task-list error details</summary>
                <p>{visible()?.tasksError}</p>
              </details>
            </>
          </Show>
        </header>

        <div class="lazers-models-comparison-content">
          <section
            class="lazers-models-compare"
            aria-label="Model comparison"
            ref={(element) => {
              comparison = element
            }}
          >
            <details class="lazers-models-sources-details">
              <summary>Sources</summary>
              <div class="lazers-models-sources" aria-label="Source snapshot coverage">
                <For each={visible()?.comparison?.sources ?? []}>
                  {(source) => (
                    <div
                      class="lazers-models-source"
                      title={source.snapshot?.sourceURL ?? sourceTitle(source.source)}
                    >
                      <strong>{sourceTitle(source.source)}</strong>
                      <span>{sourceState(source)}</span>
                      <Show when={source.refresh?.state === "failed"}>
                        <span class="lazers-models-source-warning">
                          Latest refresh failed
                          {source.refresh?.errorCode ? ` · ${source.refresh.errorCode}` : ""}
                          {source.refresh?.httpStatus ? ` · HTTP ${source.refresh.httpStatus}` : ""}
                        </span>
                      </Show>
                      <Show when={source.refresh?.state === "refreshing"}>
                        <span class="lazers-models-source-warning">Refresh in progress</span>
                      </Show>
                      <Show when={source.refresh?.state === "cancelled"}>
                        <span class="lazers-models-source-warning">Latest refresh cancelled</span>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={visible()?.sourceRefreshError}>
                  <p class="lazers-models-source-meta">
                    Source refresh error: {visible()?.sourceRefreshError}
                  </p>
                </Show>
                <Show when={visible()?.comparisonError}>
                  <p class="lazers-models-source-meta">
                    Comparison read error: {visible()?.comparisonError}
                  </p>
                </Show>
              </div>
            </details>

            <div class="lazers-models-overview">
              <section class="lazers-models-chart" aria-labelledby="lazers-models-chart-title">
                <div class="lazers-models-section-heading">
                  <h3 id="lazers-models-chart-title">
                    {(() => {
                      if (compareMode() === "benchmark") return "Public benchmark"
                      const points = visible()?.decisionOverview?.graph.points ?? []
                      const references = decisionChartReferences()
                      if (comparisonChartHasPlottablePoints(points)) return "Task outcomes"
                      if (comparisonChartHasPlottablePoints([], references))
                        return "Catalog estimates"
                      return "No comparison yet"
                    })()}
                  </h3>
                  <Show when={compareMode() === "observed"}>
                    <span
                      class="lazers-models-decision-status"
                      classList={{
                        "lazers-models-visually-hidden": visible()?.decisionStatus === "partial",
                      }}
                      role="status"
                      data-decision-status={visible()?.decisionStatus ?? "loading"}
                      aria-label={decisionStatusLabel(visible()?.decisionStatus ?? "loading")}
                      title={decisionStatusLabel(visible()?.decisionStatus ?? "loading")}
                    >
                      {decisionStatusSummary(visible()?.decisionStatus ?? "loading")}
                    </span>
                  </Show>
                  <div
                    class="lazers-models-compare-mode"
                    role="radiogroup"
                    aria-label="Comparison basis"
                  >
                    <For each={["observed", "benchmark"] as const}>
                      {(mode) => (
                        <button
                          type="button"
                          role="radio"
                          data-compare-mode={mode}
                          aria-checked={compareMode() === mode}
                          tabIndex={compareMode() === mode ? 0 : -1}
                          onClick={() => selectCompareMode(mode)}
                          onKeyDown={compareModeKey}
                        >
                          {mode === "observed" ? "Observed" : "Benchmark"}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <p class="lazers-models-chart-caption">
                  {compareMode() === "benchmark"
                    ? `Artificial Analysis Coding Index${benchmarkAsOf() ? ` (${benchmarkAsOf()})` : ""} · ${benchmarkPriceSourceLabel()} list price per 1M tokens, ${BENCHMARK_PRICE_MIX.input}:${BENCHMARK_PRICE_MIX.output} input:output`
                    : "Your task runs · market cost and tokens per accepted task"}
                </p>
                <Show when={compareMode() === "observed"}>
                  <Show when={decisionStatusDetail()}>
                    {(detail) => (
                      <details class="lazers-models-warning-details lazers-models-status-details">
                        <summary>Status details</summary>
                        <p>{detail()}</p>
                      </details>
                    )}
                  </Show>
                  <Show
                    when={
                      visible()?.decisionStatus === "backend-not-ready"
                        ? undefined
                        : visible()?.decisionOverview
                    }
                    fallback={
                      <p
                        class="lazers-models-chart-empty"
                        role={
                          visible()?.decisionStatus === "error" ||
                          visible()?.decisionStatus === "missing-rpc"
                            ? "alert"
                            : "status"
                        }
                      >
                        {visible()?.decisionStatus === "backend-not-ready"
                          ? "Comparison data isn't ready yet. Refresh to check again."
                          : visible()?.decisionStatus === "missing-rpc"
                            ? "Model comparison isn't available on this OpenCode server."
                            : visible()?.decisionStatus === "error"
                              ? "Comparison data couldn't be loaded. Refresh to retry."
                              : "Loading comparison…"}
                      </p>
                    }
                  >
                    {(overview) => (
                      <ComparisonChart
                        points={decisionChartPoints()}
                        references={decisionChartReferences()}
                        frontierConfigurationIDs={overview().graph.frontierConfigurationIDs}
                        selectedConfigurationID={visible()?.selectedConfigurationID}
                        onSelect={(configurationID) => state.selectConfiguration(configurationID)}
                        appearanceVersion={`${ctx.appearance.mode()}|${ctx.appearance.font("mono")}`}
                        monoFontFamily={ctx.appearance.font("mono")}
                        emptyAction={
                          <Show when={(baseline()?.points.length ?? 0) > 0}>
                            <Ui.Button
                              size="small"
                              variant="ghost-muted"
                              onClick={() => selectCompareMode("benchmark")}
                            >
                              Show public benchmark
                            </Ui.Button>
                          </Show>
                        }
                      />
                    )}
                  </Show>
                </Show>
                <Show when={compareMode() === "benchmark"}>
                  <BenchmarkChart
                    points={baseline()?.points ?? []}
                    gaps={baseline()?.gaps ?? []}
                    selectedID={selectedBenchmark()?.id ?? null}
                    onSelect={(candidateID) => state.selectCandidate(candidateID)}
                    observedLabel={observedScopeLabel()}
                    emptyText={benchmarkEmptyText()}
                    appearanceVersion={`${ctx.appearance.mode()}|${ctx.appearance.font("mono")}`}
                    monoFontFamily={ctx.appearance.font("mono")}
                    dataFooter={
                      <div class="lazers-models-benchmark-coverage">
                        <p>
                          {baseline()?.points.length ?? 0} plotted ·{" "}
                          {baseline()?.unmatchedRoutes ?? 0} loaded catalog models without a
                          benchmark match
                          {baseline()?.ambiguousRoutes
                            ? ` · ${baseline()!.ambiguousRoutes} with several benchmark rows, not matched by effort`
                            : ""}
                        </p>
                        <Show when={visible()?.comparison?.nextCursor}>
                          <Ui.Button
                            size="small"
                            variant="ghost"
                            busy={visible()?.comparisonLoading}
                            onClick={() => void state.moreCandidates()}
                          >
                            Load more catalog models
                          </Ui.Button>
                        </Show>
                      </div>
                    }
                  />
                </Show>
              </section>
            </div>
          </section>
        </div>
      </div>

      <div
        class="lazers-models-separator"
        role="separator"
        aria-label="Resize model comparison and inspector"
        aria-orientation="horizontal"
        aria-valuemin={24}
        aria-valuemax={76}
        aria-valuenow={split()}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          setSplit(
            clampSplit(
              event.key === "Home"
                ? 24
                : event.key === "End"
                  ? 76
                  : split() + (event.key === "ArrowDown" ? 5 : -5),
            ),
          )
          save({ split: split() })
        }}
      />

      <div
        class="lazers-models-inspector"
        ref={(element) => {
          inspector = element
        }}
        onScroll={(event) => save({ inspectorScroll: event.currentTarget.scrollTop })}
      >
        <Show when={prefs().tab === "assignments"}>
          <section
            class="lazers-models-assignments"
            role="tabpanel"
            id="lazers-models-assignments-panel"
            aria-labelledby="lazers-models-assignments-tab"
          >
            <Show when={visible()?.settingsLoading}>
              <p class="lazers-models-note">
                <Ui.Loader size="small" /> Loading saved assignments…
              </p>
            </Show>
            <Show when={visible()?.settingsError}>
              <p class="lazers-models-error" role="alert">
                Saved assignments unavailable: {visible()?.settingsError}
              </p>
            </Show>
            <Show when={!visible()?.settingsLoading && !visible()?.settingsError}>
              <div class="lazers-models-assignment-rows" role="group" aria-label="Persona routes">
                <For each={personas()}>
                  {(persona) => (
                    <button
                      type="button"
                      class="lazers-models-assignment-row"
                      aria-pressed={assignmentPersona() === persona.persona}
                      disabled={assignmentBlocked()}
                      onClick={() => selectAssignmentPersona(persona.persona)}
                    >
                      <span class="lazers-models-assignment-identity">
                        <strong>{persona.personaLabel}</strong>
                        <span>
                          {persona.resolution.status === "assigned"
                            ? routeLabel({
                                providerID: persona.resolution.route.providerID,
                                modelID: persona.resolution.route.id,
                                variant: persona.resolution.route.variant ?? null,
                              })
                            : "No saved route"}
                        </span>
                      </span>
                      <small>
                        {persona.resolution.status === "assigned"
                          ? `From ${persona.resolution.provenance.target.scope}`
                          : "Unassigned"}
                      </small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <AssignmentEditor />
          </section>
        </Show>
        <Show when={prefs().tab === "compare"}>
          <section
            class="lazers-models-inspector-compare"
            role="tabpanel"
            id="lazers-models-compare-panel"
            aria-labelledby="lazers-models-compare-tab"
          >
            <Show when={compareMode() === "benchmark"}>
              <Show
                when={selectedBenchmark()}
                fallback={
                  <p class="lazers-models-note" role="status">
                    Select a model on the chart to see its benchmark and list price.
                  </p>
                }
              >
                {(entry) => {
                  const route = () => entry().route
                  const price = () => entry().price
                  const scores = () => entry().benchmark
                  const summary = () =>
                    [
                      scores().codingIndex === null
                        ? "No Coding Index"
                        : `Coding ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(scores().codingIndex!)}`,
                      ...(price()
                        ? [
                            `${formatMarketAmount(price()!.blended)} / 1M tokens (${BENCHMARK_PRICE_MIX.input}:${BENCHMARK_PRICE_MIX.output})`,
                            benchmarkSourceName[price()!.source],
                          ]
                        : []),
                    ].join(" · ")
                  const perMillion = (value: number | null) =>
                    value === null ? null : `${formatMarketAmount(value)}`
                  return (
                    <>
                      <div class="lazers-models-inspector-heading">
                        <h2
                          title={routeLabel(route())}
                          aria-label={`Selected model ${entry().label}. Exact route ${routeLabel(route())}.`}
                        >
                          {boundedModelLabel(entry().label)}
                        </h2>
                        <p class="lazers-models-market-summary" role="status">
                          <small>{summary()}</small>
                        </p>
                      </div>
                      <div
                        class="lazers-models-selection-actions"
                        role="group"
                        aria-label="Selected model actions"
                      >
                        <Show when={observedConfigurationFor(route())}>
                          <Ui.Button
                            size="small"
                            variant="ghost-muted"
                            onClick={() => showObservedFor(route())}
                          >
                            Show observed cost
                          </Ui.Button>
                        </Show>
                        <Ui.Menu
                          label="Assign to…"
                          trigger="button"
                          icon="chevron-down"
                          placement="bottom-start"
                          disabled={assignDisabled()}
                          items={assignMenuItems(() => ({ ...route(), variant: null }))}
                        />
                      </div>
                      <details
                        class="lazers-models-evidence-details lazers-models-benchmark-details"
                        open={prefs().evidenceOpen ?? false}
                        onToggle={(event) => {
                          const open = event.currentTarget.open
                          if (open !== (prefs().evidenceOpen ?? false)) save({ evidenceOpen: open })
                        }}
                      >
                        <summary>Benchmark and price details</summary>
                        <div class="lazers-models-evidence-content">
                          <p>
                            Artificial Analysis · Coding {numericValue(scores().codingIndex)} ·
                            Agentic {numericValue(scores().agenticIndex)} · Intelligence{" "}
                            {numericValue(scores().intelligenceIndex)} for{" "}
                            {scores().displayName ?? scores().modelPermaslug}. Matched by the
                            OpenRouter catalog slug {scores().modelPermaslug}. The benchmark does
                            not state the effort it ran, so the score describes the model, not a
                            specific effort.
                          </p>
                          <Show when={comparisonSource("openrouter-benchmarks")?.snapshot}>
                            {(snapshot) => (
                              <p class="lazers-models-source-meta">
                                {snapshot().citation ?? "Artificial Analysis via OpenRouter"}
                                {snapshot().asOf
                                  ? ` · as of ${formatDate(snapshot().asOf!)}`
                                  : ""}{" "}
                                · retrieved {formatDate(snapshot().retrievedAt)}
                              </p>
                            )}
                          </Show>
                          <Show
                            when={price()}
                            fallback={
                              <p>
                                No list price from{" "}
                                {priceSourceOrder()
                                  .sources.map((source) => benchmarkSourceName[source])
                                  .join(" or ") || "any configured source"}
                                .
                              </p>
                            }
                          >
                            {(rate) => (
                              <p>
                                {benchmarkSourceName[rate().source]} list price per 1M tokens ·
                                input {perMillion(rate().input)} · output{" "}
                                {perMillion(rate().output)}
                                {rate().cacheRead === null
                                  ? ""
                                  : ` · cache read ${perMillion(rate().cacheRead)}`}
                                {rate().cacheWrite === null
                                  ? ""
                                  : ` · cache write ${perMillion(rate().cacheWrite)}`}
                                {rate().appliesBelowTokens
                                  ? ` · base rate for prompts under ${rate().appliesBelowTokens!.toLocaleString()} tokens`
                                  : ""}
                                {rate().retrievedAt
                                  ? ` · retrieved ${formatDate(rate().retrievedAt!)}`
                                  : ""}
                                . The chart blends {BENCHMARK_PRICE_MIX.input} input to{" "}
                                {BENCHMARK_PRICE_MIX.output} output tokens and excludes cache
                                pricing. A list price is not a task cost; Observed shows measured
                                cost per accepted task.
                              </p>
                            )}
                          </Show>
                          <p class="lazers-models-source-meta">
                            Price source order ·{" "}
                            {priceSourceOrder()
                              .sources.map((source) => benchmarkSourceName[source])
                              .join(", then ") || "none"}
                            {priceSourceOrder().configured ? "" : " (default)"}
                          </p>
                        </div>
                      </details>
                    </>
                  )
                }}
              </Show>
            </Show>
            <Show when={compareMode() === "observed"}>
              <Show
                when={selectedDecisionConfiguration()}
                fallback={
                  <p class="lazers-models-note" role="status">
                    {visible()?.decisionStatus === "missing-rpc"
                      ? "Models are unavailable. Refresh to retry."
                      : visible()?.decisionInspectLoading
                        ? "Loading model…"
                        : "Select a model to compare."}
                  </p>
                }
              >
                {(configuration) => (
                  <>
                    <div class="lazers-models-inspector-heading">
                      <h2
                        title={routeLabel(configuration().route)}
                        aria-label={`Selected model ${decisionModelFullName(configuration())}. Exact route ${routeLabel(configuration().route)}.`}
                      >
                        {decisionModelLabel(configuration())}
                        {configuration().route.variant ? ` · ${configuration().route.variant}` : ""}
                      </h2>
                      <Show when={selectedSummaryLine()}>
                        {(line) => (
                          <p
                            class="lazers-models-market-summary"
                            role="status"
                            aria-label={`Selected ${decisionModelFullName(configuration())} · exact route ${routeLabel(configuration().route)}. ${line().title}`}
                            title={line().title}
                          >
                            <small>{line().text}</small>
                          </p>
                        )}
                      </Show>
                    </div>
                    <div
                      class="lazers-models-selection-actions"
                      role="group"
                      aria-label="Selected model actions"
                    >
                      <Ui.Menu
                        label="View contributing trajectories"
                        trigger="button"
                        icon="chevron-down"
                        placement="bottom-start"
                        disabled={!selectedContributors().length}
                        items={[
                          ...selectedContributors().map((contributor) => ({
                            label: `${contributor.taskReference} · ${contributor.contribution}`,
                            onSelect: () => openContributorTrajectory(contributor),
                          })),
                          ...(visible()?.decisionInspection?.contributorPage.nextCursor
                            ? [
                                { type: "separator" as const },
                                {
                                  label: "Load more tasks",
                                  onSelect: () => void state.moreDecisionContributors(),
                                },
                              ]
                            : []),
                        ]}
                      />
                      <Ui.Menu
                        label="Assign to…"
                        trigger="button"
                        icon="chevron-down"
                        placement="bottom-start"
                        disabled={
                          !visible()?.settings || visible()?.settingsLoading || assignmentBlocked()
                        }
                        items={personas().map((persona) => ({
                          label: persona.personaLabel,
                          onSelect: () => assignSelectedRoute(persona.persona),
                        }))}
                      />
                    </div>
                    <Show
                      when={
                        visible()?.decisionRowsNextCursor ||
                        visible()?.decisionConfigurationsNextCursor
                      }
                    >
                      <details class="lazers-models-route-pages">
                        <summary>More model routes and effort options</summary>
                        <div>
                          <Show when={visible()?.decisionRowsNextCursor}>
                            <Ui.Button
                              size="small"
                              variant="ghost"
                              busy={visible()?.decisionRowsLoading}
                              onClick={() => void state.moreDecisionRows()}
                            >
                              Load more model groups
                            </Ui.Button>
                          </Show>
                          <Show when={visible()?.decisionConfigurationsNextCursor}>
                            <Ui.Button
                              size="small"
                              variant="ghost"
                              busy={visible()?.decisionConfigurationsLoading}
                              onClick={() => void state.moreDecisionConfigurations()}
                            >
                              Load more exact configurations
                            </Ui.Button>
                          </Show>
                        </div>
                      </details>
                    </Show>
                    <Show when={visible()?.decisionInspectLoading}>
                      <p class="lazers-models-note" role="status">
                        <Ui.Loader size="small" /> Loading model details…
                      </p>
                    </Show>
                    <Show when={visible()?.decisionInspectError}>
                      <div class="lazers-models-error" role="alert">
                        <p>Model details couldn't be loaded. Refresh to retry.</p>
                        <details class="lazers-models-warning-details">
                          <summary>Error details</summary>
                          <p>{visible()?.decisionInspectError}</p>
                        </details>
                      </div>
                    </Show>
                    <Show when={visible()?.decisionNotFound}>
                      <p class="lazers-models-note" role="status">
                        This model isn't in the current comparison. Choose another model.
                      </p>
                    </Show>
                    <Show when={visible()?.decisionStatus === "backend-not-ready"}>
                      <p class="lazers-models-note" role="status">
                        No estimate yet; comparison data isn't ready.
                      </p>
                    </Show>
                    <Show when={visible()?.decisionInspection}>
                      {(inspection) => (
                        <>
                          <details
                            class="lazers-models-evidence-details"
                            open={prefs().evidenceOpen ?? false}
                            onToggle={(event) => {
                              const open = event.currentTarget.open
                              if (open !== (prefs().evidenceOpen ?? false))
                                save({ evidenceOpen: open })
                            }}
                          >
                            <summary>Estimate details</summary>
                            <div class="lazers-models-evidence-content">
                              <Show when={selectedMarketEstimate()}>
                                {(summary) => (
                                  <p class="lazers-models-market-basis">{summary().title}</p>
                                )}
                              </Show>
                              <p class="lazers-models-estimate">
                                {estimateLabel(inspection().estimate)} ·{" "}
                                {estimateValuesLabel(inspection().estimate)}
                              </p>
                              <p>{estimateHistoryDescription(inspection().estimate)}</p>
                              <p class="lazers-models-history-scope">
                                {estimateHistoryScopeLabel(inspection().estimate)}
                              </p>
                              <Show when={estimateUnavailableReason(inspection().estimate)}>
                                {(reason) => <p>Estimate details · {reason()}</p>}
                              </Show>
                              <Show when={inspection().referenceEstimate}>
                                {(reference) => (
                                  <section
                                    class="lazers-models-reference-estimate"
                                    aria-label="OpenRouter actual-cohort model catalog reference estimate"
                                  >
                                    <h3>OpenRouter model catalog reference</h3>
                                    <p>{referenceCostLabel(reference())}</p>
                                    <details class="lazers-models-reference-details">
                                      <summary>
                                        OpenRouter model catalog reference coverage and source
                                      </summary>
                                      <div class="lazers-models-reference-content">
                                        <p>
                                          This reference uses observed attributed usage and
                                          published OpenRouter model catalog rates. Failed and retry
                                          effort is included as producer-reported; it is divided by
                                          accepted logical tasks. Actual task mix can differ by
                                          configuration; this is not a common workload or universal
                                          ranking. Denominator ·{" "}
                                          {formatNumber(reference().acceptedTaskCount)} accepted
                                          tasks.
                                        </p>
                                        <p>
                                          Identity · {reference().identityStatus} · source
                                          availability · {reference().provenance.availability} ·
                                          access · {reference().provenance.access} · freshness ·{" "}
                                          {reference().provenance.freshness} · exact USD per
                                          accepted task ·{" "}
                                          {reference().valueUSDPerAcceptedTask === null
                                            ? "not a scalar"
                                            : String(reference().valueUSDPerAcceptedTask)}
                                          {reference().rangeUSDPerAcceptedTask
                                            ? ` · exact range ${String(reference().rangeUSDPerAcceptedTask?.minimum)}–${String(reference().rangeUSDPerAcceptedTask?.maximum)}`
                                            : ""}
                                          {reference().knownSubtotalUSDPerAcceptedTask === null
                                            ? ""
                                            : ` · exact priced subtotal ${String(reference().knownSubtotalUSDPerAcceptedTask)} · remainder unknown`}
                                          {reference().knownSubtotalRangeUSDPerAcceptedTask
                                            ? ` · exact subtotal range ${String(reference().knownSubtotalRangeUSDPerAcceptedTask?.minimum)}–${String(reference().knownSubtotalRangeUSDPerAcceptedTask?.maximum)} · remainder unknown`
                                            : ""}
                                        </p>
                                        <p>
                                          Source snapshot ·{" "}
                                          {reference().provenance.snapshotID ?? "unavailable"} ·
                                          generation ·{" "}
                                          {reference().provenance.generation ?? "unavailable"} ·
                                          record ·{" "}
                                          {reference().provenance.recordID ?? "unavailable"}
                                          {reference().provenance.recordIndex === null
                                            ? ""
                                            : ` · index ${Number(reference().provenance.recordIndex) + 1}`}
                                          {reference().provenance.retrievedAt
                                            ? ` · retrieved ${formatDate(reference().provenance.retrievedAt)}`
                                            : " · retrieval date unavailable"}
                                        </p>
                                        <Show when={reference().provenance.sourceURL}>
                                          {(sourceURL) => (
                                            <p>
                                              <a
                                                href={sourceURL()}
                                                target="_blank"
                                                rel="noreferrer"
                                              >
                                                OpenRouter model catalog source
                                              </a>
                                            </p>
                                          )}
                                        </Show>
                                        <h3>Usage categories and rate coverage</h3>
                                        <ul>
                                          <For each={referenceUsageCategories}>
                                            {([category, label]) => (
                                              <li>
                                                {label} ·{" "}
                                                {referenceCategoryStatus(reference(), category)}
                                              </li>
                                            )}
                                          </For>
                                        </ul>
                                        <p>
                                          Failed/retry coverage ·{" "}
                                          {reference().coverage.retries.status} ·{" "}
                                          {reference().coverage.retries.attemptCount} attempts ·{" "}
                                          {reference().coverage.retries.failedAttemptCount} failed ·{" "}
                                          {reference().coverage.retries.retryAttemptCount} retries ·{" "}
                                          {reference().coverage.retries.attemptsWithCompleteUsage}{" "}
                                          with complete usage
                                        </p>
                                        <p>
                                          Attribution · {reference().coverage.attribution.status} ·{" "}
                                          {
                                            reference().coverage.attribution
                                              .matchedRouteSessionCount
                                          }{" "}
                                          matched route /{" "}
                                          {reference().coverage.attribution.relatedSessionCount}{" "}
                                          related sessions ·{" "}
                                          {reference().coverage.attribution.unknownRouteTaskCount}{" "}
                                          tasks with unknown route ·{" "}
                                          {reference().coverage.attribution.sharedSessionCount}{" "}
                                          shared ·{" "}
                                          {
                                            reference().coverage.attribution
                                              .unattributedSessionCount
                                          }{" "}
                                          unattributed
                                        </p>
                                        <Show when={reference().reasons.length > 0}>
                                          <p>Reference notes · {reference().reasons.join(", ")}</p>
                                        </Show>
                                      </div>
                                    </details>
                                  </section>
                                )}
                              </Show>
                              <Show when={inspection().knownUsageMarket?.scenarios[0]}>
                                {(scenario) => (
                                  <KnownUsageMarketScenarioCard scenario={scenario()} />
                                )}
                              </Show>
                              <section
                                class="lazers-models-decision-inspection"
                                aria-label="Producer comparison evidence"
                              >
                                <h3>Exact route</h3>
                                <p>{routeLabel(inspection().configuration.route)}</p>
                                <p>
                                  Effort ·{" "}
                                  {inspection().configuration.route.variant ?? "Not specified"}
                                </p>
                                <h3>Configuration cohort</h3>
                                <p>
                                  {inspection().cohort.acceptedTaskCount} accepted /{" "}
                                  {inspection().cohort.terminalTaskCount} terminal logical tasks ·{" "}
                                  {inspection().cohort.failedAttemptCount} failed attempts ·{" "}
                                  {inspection().cohort.retryAttemptCount} retries ·{" "}
                                  {inspection().cohort.attemptCount} total attempts
                                </p>
                                <p>{efficiencyLabel(inspection())}</p>
                                <p>
                                  Native reported charges · {inspection().nativeReportedCost.source}{" "}
                                  · {inspection().nativeReportedCost.status} ·{" "}
                                  {formatMoney(inspection().nativeReportedCost.totalUSD)} ·{" "}
                                  {inspection().nativeReportedCost.note}
                                </p>
                                <p class="lazers-models-source-meta">
                                  Current price ·{" "}
                                  {inspection().configuration.currentPrice.source ?? "unavailable"}{" "}
                                  · {inspection().configuration.currentPrice.semantics} ·{" "}
                                  {inspection().configuration.currentPrice.freshness}
                                  {inspection().configuration.currentPrice.retrievedAt
                                    ? ` · retrieved ${formatDate(inspection().configuration.currentPrice.retrievedAt)}`
                                    : " · retrieval date unavailable"}
                                  {inspection().configuration.currentPrice.sourceRecordID
                                    ? ` · source record ${inspection().configuration.currentPrice.sourceRecordID}`
                                    : ""}
                                </p>
                                <p class="lazers-models-source-meta">
                                  Price index · {inspection().context.priceIndex.source} ·{" "}
                                  {inspection().context.priceIndex.freshness} ·{" "}
                                  {inspection().context.priceIndex.semantics} ·{" "}
                                  {inspection().context.priceIndex.note}
                                </p>
                                <For each={inspection().context.priceIndex.pins}>
                                  {(pin) => (
                                    <p class="lazers-models-source-meta">
                                      {pin.source} price snapshot · {pin.freshness} · retrieved{" "}
                                      {formatDate(pin.retrievedAt)} · {pin.snapshotID} ·{" "}
                                      {pin.semantics}
                                    </p>
                                  )}
                                </For>
                              </section>
                              <details class="lazers-models-contributor-details">
                                <summary>
                                  Contributors · {inspection().contributorPage.totalCount}
                                </summary>
                                <section
                                  class="lazers-models-contributors"
                                  aria-label="Empirical contributors"
                                >
                                  <For each={inspection().contributorPage.contributors}>
                                    {(contributor) => (
                                      <article class="lazers-models-contributor">
                                        <div>
                                          <strong>
                                            {contributor.taskReference} · {contributor.contribution}
                                          </strong>
                                          <p>
                                            {contributor.tokens === null
                                              ? "Tokens unknown"
                                              : `${formatNumber(contributor.tokens)} tokens`}{" "}
                                            ·{" "}
                                            {contributor.currentMarketUSD === null
                                              ? "Current market cost unknown"
                                              : formatMoney(contributor.currentMarketUSD)}{" "}
                                            · native reported{" "}
                                            {formatMoney(contributor.nativeReportedUSD)}
                                          </p>
                                          <p class="lazers-models-source-meta">
                                            Exact route ·{" "}
                                            {contributor.route
                                              ? routeLabel(contributor.route)
                                              : "Unknown route"}
                                            {" · Membership · "}
                                            {contributorMembershipLabel(contributor.membership)}
                                          </p>
                                          <p class="lazers-models-source-meta">
                                            Attempt · {contributor.attemptID ?? "not attributed"} ·
                                            session · {contributor.sessionID || "not attributed"} ·
                                            observed {formatDate(contributor.observedAt)}
                                          </p>
                                        </div>
                                        <Ui.Button
                                          size="small"
                                          variant="ghost-muted"
                                          aria-label={`Open trajectory for ${contributor.taskReference}`}
                                          onClick={() => openContributorTrajectory(contributor)}
                                        >
                                          Open trajectory
                                        </Ui.Button>
                                      </article>
                                    )}
                                  </For>
                                  <Show when={!inspection().contributorPage.contributors.length}>
                                    <p class="lazers-models-note">
                                      No contributor records are available.
                                    </p>
                                  </Show>
                                  <Show when={inspection().contributorPage.nextCursor}>
                                    <Ui.Button
                                      size="small"
                                      variant="ghost"
                                      busy={visible()?.decisionContributorsLoading}
                                      onClick={() => void state.moreDecisionContributors()}
                                    >
                                      Load more contributors
                                    </Ui.Button>
                                  </Show>
                                </section>
                              </details>
                            </div>
                          </details>
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>

              <section class="lazers-models-inspector-block" aria-label="Selected task execution">
                <h3>Selected task</h3>
                <Show
                  when={visible()?.selectedTaskID}
                  fallback={
                    <p class="lazers-models-note">
                      Choose a project task to inspect its execution and categorized effort.
                    </p>
                  }
                >
                  <Show when={visible()?.taskLoading || visible()?.effortLoading}>
                    <p class="lazers-models-note">
                      <Ui.Loader size="small" /> Loading selected task evidence…
                    </p>
                  </Show>
                  <Show when={visible()?.taskError}>
                    <p class="lazers-models-error" role="alert">
                      Task detail unavailable: {visible()?.taskError}
                    </p>
                  </Show>
                  <Show when={visible()?.effortError}>
                    <p class="lazers-models-note" role="status">
                      Categorized effort unavailable: {visible()?.effortError}
                    </p>
                  </Show>
                  <Show when={selectedTask()}>
                    <div class="lazers-models-task-summary">
                      <p class="lazers-models-task-reference">
                        {selectedTask()?.reference} · execution{" "}
                        {selectedTask()?.execution?.state ?? "not started"}
                      </p>
                      <Ui.Button
                        size="small"
                        variant="ghost-muted"
                        aria-label={`Open trajectory for ${selectedTask()?.reference ?? "selected task"}`}
                        onClick={openSelectedTrajectory}
                      >
                        Open trajectory
                      </Ui.Button>
                    </div>
                    <p class="lazers-models-task-objective">
                      {selectedTask()?.task.proposal.objective}
                    </p>
                  </Show>
                  <Show when={visible()?.effortBasis}>
                    {(basis) => (
                      <details class="lazers-models-task-effort-details">
                        <summary>{effortDetailsSummary()}</summary>
                        <div class="lazers-models-evidence-content">
                          <p class="lazers-models-coverage">
                            {basis().attempts.count} recorded attempts ·{" "}
                            {basis().usage.coverage.totalUniqueSessions} unique worker sessions
                          </p>
                          <For each={categoryRows}>
                            {([label, key]) => {
                              const measure = () => basis().usage.categories[key]
                              return (
                                <div class="lazers-models-category-row">
                                  <span>{label}</span>
                                  <span data-status={measure().status}>
                                    {measure().value === null
                                      ? statusText(measure().status)
                                      : `${formatNumber(measure().value)} tokens${measure().status === "partial" ? " · observed subtotal" : ""}`}
                                  </span>
                                </div>
                              )
                            }}
                          </For>
                          <p class="lazers-models-source-meta">
                            Session-deduplicated task effort ·{" "}
                            {basis().usage.coverage.nativeCumulativeSnapshots} native snapshots ·{" "}
                            {basis().usage.coverage.retainedCumulativeSnapshots} retained snapshots
                            · {basis().usage.coverage.additiveStepSubtotals} additive subtotals ·{" "}
                            {basis().usage.coverage.missingSessions.length} missing sessions ·{" "}
                            {basis().usage.coverage.unavailableSessions.length} unavailable sessions
                            {basis().usage.coverage.progressTruncated
                              ? " · progress evidence truncated"
                              : ""}
                          </p>
                          <p class="lazers-models-source-meta">
                            Full task cost:{" "}
                            {basis().cost.fullTaskCostUSD.valueUSD === null
                              ? "Unknown"
                              : formatMoney(basis().cost.fullTaskCostUSD.valueUSD)}{" "}
                            · market-equivalent cost:{" "}
                            {basis().cost.marketEquivalentCostUSD.valueUSD === null
                              ? "Unknown"
                              : formatMoney(basis().cost.marketEquivalentCostUSD.valueUSD)}{" "}
                            · quality: {basis().quality.status} · task class:{" "}
                            {selectedTask()?.classification.classification?.primaryKind ??
                              "Not recorded"}
                          </p>
                        </div>
                      </details>
                    )}
                  </Show>
                </Show>
              </section>

              <Show when={prefs().tab === "compare" && selectedCandidate()}>
                {(candidate) => (
                  <details class="lazers-models-evidence-details">
                    <summary>Native and external model evidence</summary>
                    <div class="lazers-models-evidence-content">
                      <p>
                        Native catalog ·{" "}
                        {candidate().native.enabled === null
                          ? "availability unknown"
                          : candidate().native.enabled
                            ? "available"
                            : "disabled"}{" "}
                        · {candidate().native.evidence.recordCount} record(s) ·{" "}
                        {candidate().native.type ?? "type not reported"} ·{" "}
                        {numericValue(candidate().native.contextTokens)} context tokens ·{" "}
                        {variantCoverageLabel(candidate())}
                      </p>
                      <p>
                        OpenRouter model · {candidate().correspondence.status} ·{" "}
                        {candidate().externalModel?.name ??
                          candidate().externalModel?.id ??
                          "no exact record"}{" "}
                        · benchmark {candidate().benchmarkCorrespondence.status} ·{" "}
                        {candidate().externalBenchmark
                          ? benchmarkLabel(candidate())
                          : "unavailable"}
                      </p>
                      <p>
                        Selected route variant · {candidate().identity.variant ?? "Not specified"}
                      </p>
                      <For each={candidate().native.evidence.records}>
                        {(reference) => <code>{recordReferenceLabel(reference)}</code>}
                      </For>
                      <For each={candidate().externalModelEvidence.records}>
                        {(reference) => <code>{recordReferenceLabel(reference)}</code>}
                      </For>
                      <For each={candidate().externalBenchmarkEvidence.records}>
                        {(reference) => <code>{recordReferenceLabel(reference)}</code>}
                      </For>
                      <Show when={candidate().externalBenchmark}>
                        {(benchmark) => (
                          <p>
                            External coding benchmark · index{" "}
                            {numericValue(benchmark().codingIndex)} · effort{" "}
                            {benchmark().effort ?? "Not reported"}; not a task-fit estimate.
                          </p>
                        )}
                      </Show>
                      <Show when={visible()?.comparison?.sources}>
                        <For each={visible()?.comparison?.sources ?? []}>
                          {(source) => (
                            <p>
                              {sourceTitle(source.source)} ·{" "}
                              {source.snapshot
                                ? `retrieved ${formatDate(source.snapshot.retrievedAt)} · ${source.snapshot.sourceURL}`
                                : "No snapshot date"}{" "}
                              · {sourceState(source)}
                            </p>
                          )}
                        </For>
                      </Show>
                      <p>
                        External benchmarks and model metadata are separate from LAZERS producer
                        outcomes. Missing correspondence and price remain unknown.
                      </p>
                    </div>
                  </details>
                )}
              </Show>
            </Show>
          </section>
        </Show>
      </div>
    </div>
  )
}

export function setupModelsPanel(ctx: ModelsContext, openTrajectory: TaskTrajectoryOpener) {
  const Ui = ctx.ui
  registerModelsPanel(
    ctx,
    css,
    bindPlugin((props: PanelProps) => (
      <ModelPanel {...props} ctx={ctx} openTrajectory={openTrajectory} />
    )),
    () => (
      <div class="flex min-w-0 items-center gap-1.5">
        <Ui.Icon name="settings-gear" size="small" class="shrink-0" />
        <span>Models</span>
      </div>
    ),
  )
}
