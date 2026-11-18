import { For, Show } from "solid-js"
import type { KnownUsageMarketScenario } from "./market-range.ts"
import { formatDate, joinSegments, retrievedLabel } from "./comparison-presentation.ts"
import { statusText } from "./panel-shared.ts"

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
        : undefined
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
        {joinSegments([
          sourcePresentation().compact,
          provenance().providerName && `provider ${provenance().providerName}`,
          provenance().tag && `tag ${provenance().tag}`,
          provenance().serviceTier && `service tier ${provenance().serviceTier}`,
          freshness(),
          formatDate(provenance().retrievedAt),
        ])}
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
                {retrievedLabel(scenario().cacheWriteEvidence.retrievedAt)
                  ? ` · ${retrievedLabel(scenario().cacheWriteEvidence.retrievedAt)}`
                  : ""}
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
