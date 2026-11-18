import { Show, For, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { PanelStatus } from "../panel-status.tsx"
import { ComparisonChart, comparisonChartHasPlottablePoints } from "./comparison-chart.tsx"
import { BenchmarkChart, benchmarkSourceName } from "./benchmark-chart.tsx"
import { BENCHMARK_PRICE_MIX } from "./benchmark-baseline.ts"
import {
  boundedModelLabel,
  formatDate,
  joinSegments,
  retrievedLabel,
  formatMarketAmount,
  numericValue,
  recordReferenceLabel,
  routeLabel,
  sourceState,
  sourceTitle,
} from "./comparison-presentation.ts"
import { KnownUsageMarketScenarioCard } from "./known-usage-card.tsx"
import {
  formatMoney,
  formatNumber,
  chartHeightBounds,
  chartFooterReserve,
  hasCompareLowerPane,
  statusText,
} from "./panel-shared.ts"
import { Disclosure, SplitPane } from "./panel-layout.tsx"
import {
  benchmarkLabel,
  contributorMembership,
  efficiencySummary,
  estimateHeadline,
  estimateHistoryNote,
  estimateHistoryScope,
  estimateUnavailableReason,
  estimateValues,
  referenceCategorySummary,
  referenceCostSummary,
  referenceUsageCategories,
  variantCoverage,
} from "./selected-model-presentation.ts"

/** Source snapshots and their refresh state; lives inside the basis disclosures. */
function SourcesDetails(props: { ctl: ModelsController }) {
  const { sourceWarning, visible } = props.ctl
  return (
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
        <Show when={sourceWarning()}>
          {(warning) => <p class="lazers-models-source-meta">{warning().message}</p>}
        </Show>
        <Show when={visible()?.tasksError}>
          <p class="lazers-models-source-meta">Task list unavailable: {visible()?.tasksError}</p>
        </Show>
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
  )
}

/** The Benchmark view when OpenRouter has delivered nothing: what is needed, and the two ways out. */
export function BenchmarkEmptyState(props: {
  ui: ModelsController["Ui"]
  onOpenSettings: () => void
  onRetry: () => void
}) {
  const Ui = props.ui
  return (
    <div class="lazers-models-empty-state">
      <h3>Benchmarks need OpenRouter</h3>
      <p>Connect OpenRouter in OpenCode to load public benchmark scores and list prices.</p>
      <div>
        <Ui.Button size="small" onClick={props.onOpenSettings}>
          Open provider settings
        </Ui.Button>
        <Ui.Button size="small" variant="ghost-muted" onClick={props.onRetry}>
          Retry
        </Ui.Button>
      </div>
    </div>
  )
}

/** Compare mode top pane: the chart or the benchmark chart. */
export function CompareTop(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    baseline,
    benchmarkAsOf,
    benchmarkEmptyText,
    benchmarkNeedsOpenRouter,
    observedCaption,
    openProviderSettings,
    benchmarkPriceSourceLabel,
    chartHeight,
    compareMode,
    ctx,
    decisionChartPoints,
    dataMount,
    decisionChartReferences,
    refreshAll,
    status,
    selectCompareMode,
    selectedBenchmark,
    setChartHeight,
    state,
    visible,
  } = ctl

  // Size the plot from the space left in the top pane. Chart data and the legend sit
  // below the plot, so opening them scrolls the pane instead of shrinking the plot.
  const fitChart = () => {
    const plot = ctl.refs.topPane?.querySelector<HTMLElement>(
      ".lazers-models-comparison-chart-plot",
    )
    if (
      !ctl.refs.topPane ||
      !plot ||
      ctl.refs.topPane.clientHeight <= 0 ||
      !plot.getClientRects().length
    )
      return
    const offset =
      plot.getBoundingClientRect().top -
      ctl.refs.topPane.getBoundingClientRect().top +
      ctl.refs.topPane.scrollTop
    const next = Math.round(
      Math.min(
        chartHeightBounds.maximum,
        Math.max(
          chartHeightBounds.minimum,
          ctl.refs.topPane.clientHeight - offset - chartFooterReserve,
        ),
      ),
    )
    if (next !== chartHeight()) setChartHeight(next)
  }
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => fitChart())
    for (const element of [ctl.refs.topPane, ctl.refs.header, ctl.refs.comparison])
      if (element) observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  return (
    <section
      class="lazers-models-compare"
      aria-label="Model comparison"
      ref={(element) => {
        ctl.refs.comparison = element
      }}
    >
      <PanelStatus ui={Ui} status={status} onRetry={refreshAll} skeleton="chart" />
      <Show when={status.showContent()}>
        <div class="lazers-models-overview" data-panel-dimmed={status.dimmed()}>
          <section class="lazers-models-chart" aria-labelledby="lazers-models-chart-title">
            <h3 id="lazers-models-chart-title" class="lazers-models-visually-hidden">
              {(() => {
                if (compareMode() === "benchmark") return "Public benchmark"
                const points = visible()?.decisionOverview?.graph.points ?? []
                const references = decisionChartReferences()
                if (comparisonChartHasPlottablePoints(points)) return "Task outcomes"
                if (comparisonChartHasPlottablePoints([], references)) return "Catalog estimates"
                return "Comparison"
              })()}
            </h3>
            <Show when={compareMode() === "observed"}>
              <Show when={visible()?.decisionOverview}>
                {(overview) => (
                  <ComparisonChart
                    dataMount={dataMount}
                    points={decisionChartPoints()}
                    references={decisionChartReferences()}
                    frontierConfigurationIDs={overview().graph.frontierConfigurationIDs}
                    caption={observedCaption()}
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
              <Show
                when={!benchmarkNeedsOpenRouter()}
                fallback={
                  <BenchmarkEmptyState
                    ui={Ui}
                    onOpenSettings={openProviderSettings}
                    onRetry={refreshAll}
                  />
                }
              >
                <BenchmarkChart
                  dataMount={dataMount}
                  points={baseline()?.points ?? []}
                  gaps={baseline()?.gaps ?? []}
                  selectedID={selectedBenchmark()?.id ?? null}
                  onSelect={(candidateID) => state.selectCandidate(candidateID)}
                  emptyText={benchmarkEmptyText()}
                  caption={`Artificial Analysis Coding Index${benchmarkAsOf() ? ` (${benchmarkAsOf()})` : ""} · ${benchmarkPriceSourceLabel()} list price per 1M tokens, ${BENCHMARK_PRICE_MIX.input}:${BENCHMARK_PRICE_MIX.output} input:output`}
                  appearanceVersion={`${ctx.appearance.mode()}|${ctx.appearance.font("mono")}`}
                  monoFontFamily={ctx.appearance.font("mono")}
                  dataFooter={
                    <div class="lazers-models-benchmark-coverage">
                      <p>
                        {baseline()?.points.length ?? 0} plotted ·{" "}
                        {baseline()?.unmatchedRoutes ?? 0} loaded catalog models without a benchmark
                        match
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
            </Show>
          </section>
        </div>
      </Show>
    </section>
  )
}

/** Compare mode inspector: the selected model, its estimate and evidence. */
function CompareInspector(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    assignDisabled,
    assignMenuItems,
    assignRoute,
    assignSelectedRoute,
    status,
    categoryRows,
    compareMode,
    comparisonSource,
    decisionModelFullName,
    decisionModelLabel,
    effortDetailsSummary,
    observedConfigurationFor,
    openContributorTrajectory,
    openSelectedTrajectory,
    personas,
    prefs,
    priceSourceOrder,
    save,
    selectedBenchmark,
    selectedCandidate,
    selectedDecisionConfiguration,
    selectedMarketEstimate,
    selectedFacts,
    filterPersona,
    basisHint,
    heldInspection,
    selectTask,
    setDataMount,
    selectedTask,
    showObservedFor,
    state,
    visible,
  } = ctl

  return (
    <section
      class="lazers-models-inspector-compare"
      data-panel-dimmed={visible()?.decisionInspectLoading ? "true" : undefined}
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
            const perMillion = (value: number | null) =>
              value === null ? null : `${formatMarketAmount(value)}`
            return (
              <>
                <div class="lazers-models-selected-heading">
                  <div class="lazers-models-selected-identity">
                    <h2
                      title={routeLabel(route())}
                      aria-label={`Selected model ${entry().label}. Exact route ${routeLabel(route())}.`}
                    >
                      {boundedModelLabel(entry().label)}
                    </h2>
                    <code>
                      {route().providerID}/{route().modelID}
                    </code>
                  </div>
                  <Show
                    when={filterPersona()}
                    fallback={
                      <span class="lazers-models-chip">
                        <Ui.Menu
                          label="Assign…"
                          trigger="button"
                          icon="chevron-down"
                          placement="bottom-end"
                          disabled={assignDisabled()}
                          items={assignMenuItems(() => ({ ...route(), variant: null }))}
                        />
                      </span>
                    }
                  >
                    {(persona) => (
                      <Ui.Button
                        size="small"
                        disabled={assignDisabled()}
                        onClick={() =>
                          assignRoute(persona().persona, { ...route(), variant: null })
                        }
                      >
                        {`Assign to ${persona().personaLabel}`}
                      </Ui.Button>
                    )}
                  </Show>
                </div>
                <Show when={price()}>
                  {(rate) => (
                    <p class="lazers-models-price">
                      <strong>{formatMarketAmount(rate().blended)}</strong>{" "}
                      <span>per 1M tokens</span>
                    </p>
                  )}
                </Show>
                <dl class="lazers-models-stats" aria-label="Benchmark scores">
                  <Show when={scores().codingIndex !== null}>
                    <div>
                      <dt>coding</dt>
                      <dd>{numericValue(scores().codingIndex)}</dd>
                    </div>
                  </Show>
                  <Show when={scores().agenticIndex !== null}>
                    <div>
                      <dt>agentic</dt>
                      <dd>{numericValue(scores().agenticIndex)}</dd>
                    </div>
                  </Show>
                  <Show when={scores().intelligenceIndex !== null}>
                    <div>
                      <dt>intelligence</dt>
                      <dd>{numericValue(scores().intelligenceIndex)}</dd>
                    </div>
                  </Show>
                </dl>
                <Show when={observedConfigurationFor(route())}>
                  <Ui.Button
                    size="small"
                    variant="ghost-muted"
                    onClick={() => showObservedFor(route())}
                  >
                    Show observed cost
                  </Ui.Button>
                </Show>
                <details
                  class="lazers-models-disclosure lazers-models-evidence-details lazers-models-benchmark-details"
                  open={prefs().evidenceOpen ?? false}
                  onToggle={(event) => {
                    const open = event.currentTarget.open
                    if (open !== (prefs().evidenceOpen ?? false)) save({ evidenceOpen: open })
                  }}
                >
                  <summary>
                    <span>Benchmark and price details</span>
                    <Show when={price()}>
                      {(rate) => (
                        <span class="lazers-models-disclosure-hint">
                          {benchmarkSourceName[rate().source]}
                        </span>
                      )}
                    </Show>
                  </summary>
                  <div class="lazers-models-evidence-content">
                    <p>
                      Artificial Analysis · Coding {numericValue(scores().codingIndex)} · Agentic{" "}
                      {numericValue(scores().agenticIndex)} · Intelligence{" "}
                      {numericValue(scores().intelligenceIndex)} for{" "}
                      {scores().displayName ?? scores().modelPermaslug}. Matched by the OpenRouter
                      catalog slug {scores().modelPermaslug}. The benchmark does not state the
                      effort it ran, so the score describes the model, not a specific effort.
                    </p>
                    <Show when={comparisonSource("openrouter-benchmarks")?.snapshot}>
                      {(snapshot) => (
                        <p class="lazers-models-source-meta">
                          {snapshot().citation ?? "Artificial Analysis via OpenRouter"}
                          {joinSegments([
                            snapshot().asOf && `as of ${formatDate(snapshot().asOf!)}`,
                            retrievedLabel(snapshot().retrievedAt),
                          ])}
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
                          {benchmarkSourceName[rate().source]} list price per 1M tokens · input{" "}
                          {perMillion(rate().input)} · output {perMillion(rate().output)}
                          {rate().cacheRead === null
                            ? ""
                            : ` · cache read ${perMillion(rate().cacheRead)}`}
                          {rate().cacheWrite === null
                            ? ""
                            : ` · cache write ${perMillion(rate().cacheWrite)}`}
                          {rate().appliesBelowTokens
                            ? ` · base rate for prompts under ${rate().appliesBelowTokens!.toLocaleString()} tokens`
                            : ""}
                          {rate().retrievedAt ? ` · ${retrievedLabel(rate().retrievedAt!)}` : ""}.
                          The chart blends {BENCHMARK_PRICE_MIX.input} input to{" "}
                          {BENCHMARK_PRICE_MIX.output} output tokens and excludes cache pricing. A
                          list price is not a task cost; Observed shows measured cost per accepted
                          task.
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
                    <SourcesDetails ctl={ctl} />
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
            <Show when={status.view().kind === "ready" && visible()?.decisionOverview}>
              <p class="lazers-models-note">Select a model on the chart.</p>
            </Show>
          }
        >
          {(configuration) => (
            <>
              <div class="lazers-models-selected-heading">
                <div class="lazers-models-selected-identity">
                  <h2
                    title={routeLabel(configuration().route)}
                    aria-label={`Selected model ${decisionModelFullName(configuration())}. Exact route ${routeLabel(configuration().route)}.`}
                  >
                    {decisionModelLabel(configuration())}
                  </h2>
                  <code>
                    {configuration().route.providerID}/{configuration().route.modelID}
                    {configuration().route.variant ? ` · ${configuration().route.variant}` : ""}
                  </code>
                </div>
                <Show
                  when={filterPersona()}
                  fallback={
                    <span class="lazers-models-chip">
                      <Ui.Menu
                        label="Assign…"
                        trigger="button"
                        icon="chevron-down"
                        placement="bottom-end"
                        disabled={assignDisabled()}
                        items={personas().map((persona) => ({
                          label: persona.personaLabel,
                          onSelect: () => assignSelectedRoute(persona.persona),
                        }))}
                      />
                    </span>
                  }
                >
                  {(persona) => (
                    <Ui.Button
                      size="small"
                      disabled={assignDisabled()}
                      onClick={() => assignSelectedRoute(persona().persona)}
                    >
                      {`Assign to ${persona().personaLabel}`}
                    </Ui.Button>
                  )}
                </Show>
              </div>
              <Show when={selectedFacts()?.price}>
                {(price) => (
                  <p class="lazers-models-price">
                    <strong>{price()}</strong> <span>per accepted task</span>
                  </p>
                )}
              </Show>
              <Show when={selectedFacts()}>
                {(facts) => (
                  <dl class="lazers-models-stats" aria-label="Selected model facts">
                    <Show when={facts().accepted !== undefined && facts().terminal !== undefined}>
                      <div>
                        <dt>accepted</dt>
                        <dd>
                          {facts().accepted} of {facts().terminal}
                        </dd>
                      </div>
                    </Show>
                    <Show when={facts().tokens}>
                      {(tokens) => (
                        <div>
                          <dt>tokens / task</dt>
                          <dd>{tokens()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={facts().time}>
                      {(time) => (
                        <div>
                          <dt>median time</dt>
                          <dd>{time()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={facts().attempts}>
                      {(attempts) => (
                        <div>
                          <dt>attempts / task</dt>
                          <dd>{attempts()}</dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                )}
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
              <Show when={heldInspection()}>
                {(inspection) => (
                  <>
                    <details
                      class="lazers-models-disclosure lazers-models-evidence-details"
                      open={prefs().evidenceOpen ?? false}
                      onToggle={(event) => {
                        const open = event.currentTarget.open
                        if (open !== (prefs().evidenceOpen ?? false)) save({ evidenceOpen: open })
                      }}
                    >
                      <summary>
                        <span>Estimate basis and prices</span>
                        <Show when={basisHint()}>
                          {(hint) => <span class="lazers-models-disclosure-hint">{hint()}</span>}
                        </Show>
                      </summary>
                      <div class="lazers-models-evidence-content">
                        <Show when={selectedMarketEstimate()}>
                          {(summary) => <p class="lazers-models-market-basis">{summary().title}</p>}
                        </Show>
                        <p class="lazers-models-estimate">
                          {joinSegments([
                            estimateHeadline(inspection().estimate),
                            estimateValues(inspection().estimate),
                          ])}
                        </p>
                        <p>{estimateHistoryNote(inspection().estimate)}</p>
                        <Show when={estimateHistoryScope(inspection().estimate)}>
                          {(scope) => <p class="lazers-models-history-scope">{scope()}</p>}
                        </Show>
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
                              <Show when={referenceCostSummary(reference())}>
                                {(summary) => <p>{summary()}</p>}
                              </Show>
                              <details class="lazers-models-reference-details">
                                <summary>
                                  OpenRouter model catalog reference coverage and source
                                </summary>
                                <div class="lazers-models-reference-content">
                                  <p>
                                    This reference uses observed attributed usage and published
                                    OpenRouter model catalog rates. Failed and retry effort is
                                    included as producer-reported; it is divided by accepted logical
                                    tasks. Actual task mix can differ by configuration; this is not
                                    a common workload or universal ranking. Denominator ·{" "}
                                    {formatNumber(reference().acceptedTaskCount)} accepted tasks.
                                  </p>
                                  <p>
                                    Identity · {reference().identityStatus} · source availability ·{" "}
                                    {reference().provenance.availability} · access ·{" "}
                                    {reference().provenance.access} · freshness ·{" "}
                                    {reference().provenance.freshness} · exact USD per accepted task
                                    ·{" "}
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
                                    {joinSegments([
                                      "Source snapshot",
                                      reference().provenance.snapshotID,
                                      reference().provenance.generation !== null &&
                                        `generation ${reference().provenance.generation}`,
                                      reference().provenance.recordID &&
                                        `record ${reference().provenance.recordID}`,
                                      reference().provenance.recordIndex !== null &&
                                        `index ${Number(reference().provenance.recordIndex) + 1}`,
                                      retrievedLabel(reference().provenance.retrievedAt),
                                    ])}
                                  </p>
                                  <Show when={reference().provenance.sourceURL}>
                                    {(sourceURL) => (
                                      <p>
                                        <a href={sourceURL()} target="_blank" rel="noreferrer">
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
                                          {referenceCategorySummary(reference(), category)}
                                        </li>
                                      )}
                                    </For>
                                  </ul>
                                  <p>
                                    Failed/retry coverage · {reference().coverage.retries.status} ·{" "}
                                    {reference().coverage.retries.attemptCount} attempts ·{" "}
                                    {reference().coverage.retries.failedAttemptCount} failed ·{" "}
                                    {reference().coverage.retries.retryAttemptCount} retries ·{" "}
                                    {reference().coverage.retries.attemptsWithCompleteUsage} with
                                    complete usage
                                  </p>
                                  <p>
                                    {joinSegments([
                                      `Attribution · ${reference().coverage.attribution.status}`,
                                      `${reference().coverage.attribution.matchedRouteSessionCount} matched route / ${reference().coverage.attribution.relatedSessionCount} related sessions`,
                                      reference().coverage.attribution.unknownRouteTaskCount > 0 &&
                                        `${reference().coverage.attribution.unknownRouteTaskCount} tasks with unknown route`,
                                      `${reference().coverage.attribution.sharedSessionCount} shared`,
                                      `${reference().coverage.attribution.unattributedSessionCount} unattributed`,
                                    ])}
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
                          {(scenario) => <KnownUsageMarketScenarioCard scenario={scenario()} />}
                        </Show>
                        <section
                          class="lazers-models-decision-inspection"
                          aria-label="Producer comparison evidence"
                        >
                          <h3>Exact route</h3>
                          <p>{routeLabel(inspection().configuration.route)}</p>
                          <Show when={inspection().configuration.route.variant}>
                            {(variant) => <p>Effort · {variant()}</p>}
                          </Show>
                          <h3>Configuration cohort</h3>
                          <p>
                            {inspection().cohort.acceptedTaskCount} accepted /{" "}
                            {inspection().cohort.terminalTaskCount} terminal logical tasks ·{" "}
                            {inspection().cohort.failedAttemptCount} failed attempts ·{" "}
                            {inspection().cohort.retryAttemptCount} retries ·{" "}
                            {inspection().cohort.attemptCount} total attempts
                          </p>
                          <p>{efficiencySummary(inspection().efficiency)}</p>
                          <p>
                            {joinSegments([
                              "Native reported charges",
                              inspection().nativeReportedCost.source,
                              inspection().nativeReportedCost.status,
                              inspection().nativeReportedCost.totalUSD !== null &&
                                formatMoney(inspection().nativeReportedCost.totalUSD!),
                              inspection().nativeReportedCost.note,
                            ])}
                          </p>
                          <p class="lazers-models-source-meta">
                            {joinSegments([
                              "Current price",
                              inspection().configuration.currentPrice.source,
                              inspection().configuration.currentPrice.semantics,
                              inspection().configuration.currentPrice.freshness,
                              retrievedLabel(inspection().configuration.currentPrice.retrievedAt),
                              inspection().configuration.currentPrice.sourceRecordID &&
                                `source record ${inspection().configuration.currentPrice.sourceRecordID}`,
                            ])}
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
                                {joinSegments([
                                  `${pin.source} price snapshot`,
                                  pin.freshness,
                                  retrievedLabel(pin.retrievedAt),
                                  pin.snapshotID,
                                  pin.semantics,
                                ])}
                              </p>
                            )}
                          </For>
                        </section>
                        <SourcesDetails ctl={ctl} />
                      </div>
                    </details>
                    <Disclosure
                      title="Runs with this model"
                      hint={`${inspection().contributorPage.totalCount}`}
                    >
                      <div class="lazers-models-contributor-details">
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
                                    {joinSegments([
                                      contributor.tokens !== null &&
                                        `${formatNumber(contributor.tokens)} tokens`,
                                      contributor.currentMarketUSD !== null &&
                                        formatMoney(contributor.currentMarketUSD),
                                      contributor.nativeReportedUSD !== null &&
                                        `native reported ${formatMoney(contributor.nativeReportedUSD)}`,
                                    ])}
                                  </p>
                                  <p class="lazers-models-source-meta">
                                    {joinSegments([
                                      contributor.route &&
                                        `Exact route · ${routeLabel(contributor.route)}`,
                                      contributorMembership(contributor.membership) &&
                                        `Membership · ${contributorMembership(contributor.membership)}`,
                                    ])}
                                  </p>
                                  <p class="lazers-models-source-meta">
                                    {joinSegments([
                                      contributor.attemptID && `Attempt · ${contributor.attemptID}`,
                                      contributor.sessionID && `session · ${contributor.sessionID}`,
                                      contributor.observedAt &&
                                        `observed ${formatDate(contributor.observedAt)}`,
                                    ])}
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
                            <p class="lazers-models-note">No contributor records are available.</p>
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
                      </div>
                      <section
                        class="lazers-models-inspector-block"
                        aria-label="Selected task execution"
                      >
                        <h3>Selected task</h3>
                        <Show when={(visible()?.tasks.length ?? 0) > 1}>
                          <Ui.Menu
                            label={selectedTask()?.reference ?? "Choose a task"}
                            trigger="button"
                            icon="chevron-down"
                            items={(visible()?.tasks ?? []).map((entry) => ({
                              label: `${entry.reference} · ${entry.title || entry.objective} · ${entry.status}`,
                              onSelect: () => selectTask(entry.taskID),
                            }))}
                          />
                        </Show>
                        <Show
                          when={visible()?.selectedTaskID}
                          fallback={
                            <p class="lazers-models-note">
                              Choose a project task to inspect its execution and categorized effort.
                            </p>
                          }
                        >
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
                                    {basis().usage.coverage.totalUniqueSessions} unique worker
                                    sessions
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
                                              : `${formatNumber(measure().value!)} tokens${measure().status === "partial" ? " · observed subtotal" : ""}`}
                                          </span>
                                        </div>
                                      )
                                    }}
                                  </For>
                                  <p class="lazers-models-source-meta">
                                    Session-deduplicated task effort ·{" "}
                                    {basis().usage.coverage.nativeCumulativeSnapshots} native
                                    snapshots · {basis().usage.coverage.retainedCumulativeSnapshots}{" "}
                                    retained snapshots ·{" "}
                                    {basis().usage.coverage.additiveStepSubtotals} additive
                                    subtotals · {basis().usage.coverage.missingSessions.length}{" "}
                                    missing sessions ·{" "}
                                    {basis().usage.coverage.unavailableSessions.length} unavailable
                                    sessions
                                    {basis().usage.coverage.progressTruncated
                                      ? " · progress evidence truncated"
                                      : ""}
                                  </p>
                                  <p class="lazers-models-source-meta">
                                    {joinSegments([
                                      basis().cost.fullTaskCostUSD.valueUSD !== null &&
                                        `Full task cost: ${formatMoney(basis().cost.fullTaskCostUSD.valueUSD!)}`,
                                      basis().cost.marketEquivalentCostUSD.valueUSD !== null &&
                                        `market-equivalent cost: ${formatMoney(basis().cost.marketEquivalentCostUSD.valueUSD!)}`,
                                      `quality: ${basis().quality.status}`,
                                      selectedTask()?.classification.classification?.primaryKind &&
                                        `task class: ${selectedTask()?.classification.classification?.primaryKind}`,
                                    ])}
                                  </p>
                                </div>
                              </details>
                            )}
                          </Show>
                        </Show>
                      </section>
                    </Disclosure>
                    <Show when={selectedCandidate()?.externalBenchmark}>
                      {(benchmark) => (
                        <Disclosure
                          title="Public benchmark"
                          hint={
                            benchmark().codingIndex === null
                              ? undefined
                              : `Coding index ${benchmark().codingIndex}`
                          }
                        >
                          <Show when={selectedCandidate()}>
                            {(candidate) => (
                              <>
                                <p>
                                  {joinSegments([
                                    candidate().native.enabled === null
                                      ? "Native catalog"
                                      : `Native catalog · ${candidate().native.enabled ? "available" : "disabled"}`,
                                    `${candidate().native.evidence.recordCount} record(s)`,
                                    candidate().native.type,
                                    numericValue(candidate().native.contextTokens) &&
                                      `${numericValue(candidate().native.contextTokens)} context tokens`,
                                    variantCoverage(candidate()),
                                  ])}
                                </p>
                                <p>
                                  {joinSegments([
                                    `OpenRouter model · ${candidate().correspondence.status}`,
                                    candidate().externalModel?.name ??
                                      candidate().externalModel?.id,
                                    `benchmark ${candidate().benchmarkCorrespondence.status}`,
                                    benchmarkLabel(candidate()),
                                  ])}
                                </p>
                                <Show when={candidate().identity.variant}>
                                  {(variant) => <p>Selected route variant · {variant()}</p>}
                                </Show>
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
                                      {joinSegments([
                                        "External coding benchmark",
                                        numericValue(benchmark().codingIndex) &&
                                          `index ${numericValue(benchmark().codingIndex)}`,
                                        benchmark().effort && `effort ${benchmark().effort}`,
                                      ])}
                                      ; not a task-fit estimate.
                                    </p>
                                  )}
                                </Show>
                                <Show when={visible()?.comparison?.sources}>
                                  <For each={visible()?.comparison?.sources ?? []}>
                                    {(source) => (
                                      <p>
                                        {joinSegments([
                                          sourceTitle(source.source),
                                          retrievedLabel(source.snapshot?.retrievedAt),
                                          source.snapshot?.sourceURL,
                                          sourceState(source),
                                        ])}
                                      </p>
                                    )}
                                  </For>
                                </Show>
                                <p>
                                  External benchmarks and model metadata are separate from LAZERS
                                  producer outcomes.
                                </p>
                              </>
                            )}
                          </Show>
                        </Disclosure>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </Show>
      <div
        ref={(element) => {
          setDataMount(element)
          onCleanup(() => setDataMount(undefined))
        }}
      />
    </section>
  )
}

export function CompareView(props: { ctl: ModelsController; header: JSX.Element }) {
  const { benchmarkNeedsOpenRouter, compareMode, status } = props.ctl
  // One loading surface, and the actionable empty state: header, filters and that, no lower pane.
  const solo = () =>
    !hasCompareLowerPane({
      contentShown: status.showContent(),
      benchmark: compareMode() === "benchmark",
      benchmarkNeedsOpenRouter: benchmarkNeedsOpenRouter(),
    })
  return (
    <SplitPane
      solo={solo()}
      ctl={props.ctl}
      header={props.header}
      top={<CompareTop ctl={props.ctl} />}
      bottom={<CompareInspector ctl={props.ctl} />}
    />
  )
}
