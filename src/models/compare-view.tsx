import { Show, For, createMemo, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { PanelStatus } from "../panel-status.tsx"
import { ModelChart, RankingChart } from "./model-chart.tsx"
import { AllModelsTable } from "./all-models-table.tsx"
import {
  benchmarkSourceName,
  comparisonChartEmptyText,
  freeEntries,
  projectedRankRows,
  shortModelLabel,
} from "./chart-data.ts"
import { RANK_LOG_RATIO, formatAxisMoney, formatAxisTokens } from "./chart-layout.ts"
import { catalogSummaryText, entryProvenanceText } from "./catalog-projection.ts"
import { BENCHMARK_PRICE_MIX } from "./benchmark-baseline.ts"
import {
  boundedModelLabel,
  joinSegments,
  formatMarketAmount,
  formatMarketRange,
  compactCount,
  routeLabel,
  sourceState,
  sourceTitle,
} from "./comparison-presentation.ts"
import { BenchmarkModelPane, ObservedModelPane } from "./model-pane.tsx"
import { benchmarkPaneModel, observedPaneModel } from "./pane-presentation.ts"
import { hasCompareLowerPane } from "./panel-shared.ts"
import { Disclosure, Segmented, SplitPane, revealDetails } from "./panel-layout.tsx"

/** Source snapshots and their refresh state; lives inside the basis disclosures. */
function SourcesDetails(props: { ctl: ModelsController }) {
  const { sourceWarning, visible } = props.ctl
  return (
    <details class="lazers-models-sources-details">
      <summary>Sources</summary>
      <For each={props.ctl.catalogNotes()}>
        {(note) => <p class="lazers-models-source-meta">{note}.</p>}
      </For>
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
      <h3>No benchmark source reachable</h3>
      <p>
        Public coding scores load from Epoch AI, which needs no key, and from OpenRouter when it is
        connected in OpenCode. Neither has answered yet: retry, or check the network.
      </p>
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

/** The Projected plot: a ranking that needs no second measure, and a cost-vs-score scatter. */
function ProjectedPlot(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    catalogEntries,
    catalogNotes,
    openProviderSettings,
    profile,
    projectedPoints,
    refreshAll,
    state,
    visible,
  } = ctl
  const [view, setView] = createSignal<"ranking" | "scatter">("ranking")
  const rows = createMemo(() => projectedRankRows(catalogEntries()))
  const scored = () => projectedPoints().length
  // Models their source lists as free sit below the ranking, collapsed.
  const freeModels = createMemo(() => freeEntries(catalogEntries()))
  // The scatter is a secondary view, offered only when enough models have a public score.
  const scatter = () => view() === "scatter" && scored() >= 5
  const selectedID = () => ctl.selectedEntryID()
  return (
    <Show
      when={rows().length > 0}
      fallback={
        <div class="lazers-models-empty-state">
          <h3>Nothing to project yet</h3>
          <p>
            {profile()
              ? `No source prices any model. ${catalogNotes().join(" · ")}`.trim()
              : "There are no accepted tasks to project from yet."}
          </p>
          <div>
            <Ui.Button size="small" onClick={openProviderSettings}>
              Open provider settings
            </Ui.Button>
            <Ui.Button size="small" variant="ghost-muted" onClick={refreshAll}>
              Retry
            </Ui.Button>
          </div>
        </div>
      }
    >
      {/* The picker stays while a basis scores fewer than five models: it is the way back. */}
      <Show when={scored() >= 5 || ctl.scoreOptions().length > 1}>
        <div class="lazers-chart-modes">
          <Show when={scored() >= 5}>
            <Segmented
              label="Projected plot"
              value={view()}
              onChange={setView}
              options={[
                { value: "ranking", label: "Ranking" },
                { value: "scatter", label: "Cost vs score" },
              ]}
            />
          </Show>
          <Show when={ctl.scoreOptions().length > 1}>
            <label class="lazers-score-basis">
              <span>Score:</span>
              <select
                aria-label="Score basis"
                value={ctl.scoreBasisKey()}
                onChange={(event) => ctl.setScoreBasisKey(event.currentTarget.value)}
              >
                <For each={ctl.scoreOptions()}>
                  {(option) => (
                    <option value={option.key} selected={option.key === ctl.scoreBasisKey()}>
                      {option.basis.label} · {option.routes}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
        </div>
      </Show>
      <Show
        when={scatter()}
        fallback={
          <RankingChart
            rows={rows()}
            selectedID={selectedID()}
            onSelect={(id) => {
              revealDetails(ctl)
              ctl.pickEntryID(id)
            }}
            formatValue={formatMarketAmount}
            title="Projected cost per accepted task"
            label="Projected cost ranking. Arrow keys move between models; Enter selects."
            backedLegend="From your runs"
            showScore={rows().some((row) => row.score != null)}
            caption="List prices × your median tokens"
          />
        }
      >
        <ModelChart
          points={projectedPoints()}
          selectedID={selectedID()}
          onSelect={(candidateID) => {
            revealDetails(ctl)
            ctl.pickEntryID(candidateID)
          }}
          xTitle="Projected cost per accepted task"
          yTitle={ctl.scoreBasis().label}
          formatX={formatAxisMoney}
          formatY={(value) => String(Math.round(value))}
          xScale="auto-log"
          xLogRatio={RANK_LOG_RATIO}
          label="Projected cost against score. Arrow keys move between models; Enter selects."
          backedLegend="From your runs"
          caption="List prices × your median tokens"
        />
      </Show>
      <Show when={freeModels().length > 0}>
        <details class="lazers-models-free">
          <summary>Free · {freeModels().length}</summary>
          <For each={freeModels()}>
            {(entry) => (
              <button
                type="button"
                class="lazers-models-free-row"
                aria-pressed={selectedID() === entry.id}
                title={entry.label}
                onClick={() => {
                  revealDetails(ctl)
                  ctl.pickEntryID(entry.id)
                }}
              >
                <span>{shortModelLabel(entry.label)}</span>
                <small>free</small>
              </button>
            )}
          </For>
        </details>
      </Show>
    </Show>
  )
}

/** Compare mode top pane: the plot for the chosen basis, drawn by `ModelChart`. */
function CompareTop(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    baseline,
    benchmarkAsOf,
    benchmarkEmptyText,
    benchmarkNeedsOpenRouter,
    benchmarkPoints,
    benchmarkPriceSourceLabel,
    catalogLoadingLine,
    compareMode,
    decisionChartReferences,
    epochCoverageLine,
    observedCaption,
    observedPoints,
    openProviderSettings,
    projectedPoints,
    refreshAll,
    scoreBasis,
    selectCompareMode,
    selectedBenchmark,
    state,
    status,
    visible,
  } = ctl

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
              {compareMode() === "benchmark"
                ? "Public benchmark"
                : compareMode() === "projected"
                  ? "Projected cost"
                  : "Task outcomes"}
            </h3>
            <Show when={compareMode() === "observed"}>
              <Show when={visible()?.decisionOverview}>
                <ModelChart
                  points={observedPoints()}
                  selectedID={visible()?.selectedConfigurationID ?? null}
                  onSelect={(configurationID) => {
                    revealDetails(ctl)
                    state.selectConfiguration(configurationID)
                  }}
                  xTitle="Tokens per accepted task"
                  yTitle="Cost per accepted task"
                  formatX={formatAxisTokens}
                  formatY={formatAxisMoney}
                  xScale="auto-log"
                  label="Model cost chart. Arrow keys move between models; Enter selects."
                  caption={observedCaption()}
                  emptyText={comparisonChartEmptyText(
                    visible()?.decisionOverview?.graph.points ?? [],
                    decisionChartReferences(),
                  )}
                  emptyAction={
                    <Show when={(baseline()?.points.length ?? 0) > 0}>
                      <Ui.Button
                        size="small"
                        variant="ghost-muted"
                        onClick={() => selectCompareMode("projected")}
                      >
                        Show projected cost
                      </Ui.Button>
                    </Show>
                  }
                />
              </Show>
            </Show>
            <Show when={compareMode() === "projected"}>
              <ProjectedPlot ctl={ctl} />
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
                <ModelChart
                  points={benchmarkPoints()}
                  selectedID={selectedBenchmark()?.id ?? null}
                  onSelect={(candidateID) => {
                    revealDetails(ctl)
                    ctl.pickEntryID(candidateID)
                  }}
                  xTitle={`List price per 1M tokens (${BENCHMARK_PRICE_MIX.input}:${BENCHMARK_PRICE_MIX.output} in:out)`}
                  yTitle={scoreBasis().label}
                  formatX={formatAxisMoney}
                  formatY={(value) => String(Math.round(value))}
                  label="Public benchmark chart. Arrow keys move between models; Enter selects."
                  caption={`${scoreBasis().caption}${benchmarkAsOf() ? ` (${benchmarkAsOf()})` : ""} · ${benchmarkPriceSourceLabel()} list price`}
                  emptyText={benchmarkEmptyText()}
                />
                <p class="lazers-models-benchmark-coverage">
                  {baseline()?.points.length ?? 0} plotted · {baseline()?.unmatchedRoutes ?? 0}{" "}
                  loaded catalog models without a benchmark match
                  {baseline()?.ambiguousRoutes
                    ? ` · ${baseline()!.ambiguousRoutes} with several benchmark rows, not matched by effort`
                    : ""}
                  {epochCoverageLine() && scoreBasis().source === "epoch"
                    ? ` · ${epochCoverageLine()}`
                    : ""}
                  {ctl.scoredWithoutPrice().length
                    ? ` · ${ctl.scoredWithoutPrice().length} scored ${ctl.scoredWithoutPrice().length === 1 ? "model has" : "models have"} no price in any source`
                    : ""}
                </p>
                <Show
                  when={
                    ctl.scoredWithoutPrice().length > 0 ||
                    (ctl.catalogSummary()?.hidden.length ?? 0) > 0
                  }
                >
                  <details class="lazers-models-sources-details">
                    <summary>Scored models left off the plot</summary>
                    <For each={ctl.scoredWithoutPrice()}>
                      {(name) => (
                        <p class="lazers-models-source-meta">
                          {name} · no price in any configured source
                        </p>
                      )}
                    </For>
                    <Show when={ctl.catalogSummary()?.hidden.length}>
                      <p class="lazers-models-source-meta">
                        {ctl.catalogSummary()!.hidden.length} hidden by a rule: not tool-capable
                      </p>
                    </Show>
                    <For each={ctl.catalogSummary()?.hidden ?? []}>
                      {(entry) => (
                        <p class="lazers-models-source-meta">
                          {entry.name} · {entry.reason}
                        </p>
                      )}
                    </For>
                  </details>
                </Show>
              </Show>
            </Show>
            <Show when={catalogLoadingLine()}>
              {(line) => (
                <p class="lazers-models-note" role="status">
                  {line()}
                </p>
              )}
            </Show>
            <Show when={ctl.catalogEntries().length > 0}>
              <AllModelsTable
                entries={ctl.catalogEntries()}
                selectedID={ctl.allModelsSelectedID()}
                onSelect={(entry) => {
                  revealDetails(ctl)
                  ctl.selectEntry(entry)
                }}
              />
            </Show>
          </section>
        </div>
      </Show>
    </section>
  )
}

/** Projected mode: the selected catalog model's source, rates, basis and where its set came from. */
function ProjectedSummary(props: { ctl: ModelsController }) {
  const {
    catalogEntries,
    catalogNotes,
    catalogSummary,
    epochCoverage,
    epochCoverageLine,
    profile,
    scoreBasis,
    visible,
  } = props.ctl
  const entry = () => catalogEntries().find((item) => item.id === props.ctl.selectedEntryID())
  const day = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleDateString([], { day: "numeric", month: "short" }) : ""
  const perMillion = (value: number | null) =>
    value === null ? undefined : `${formatMarketAmount(value)}`
  const basis = () => {
    const median = profile()
    if (!median) return undefined
    const input = median.uncachedInput + median.cacheRead + median.cacheWrite
    return joinSegments([
      `${compactCount(input)} in`,
      median.cacheRead > 0 && `${compactCount(median.cacheRead)} cached`,
      `${compactCount(median.output + median.reasoning)} out`,
    ])
  }
  return (
    <Show
      when={entry()}
      fallback={
        <p class="lazers-models-note" role="status">
          Select a model on the chart to see its projected cost.
        </p>
      }
    >
      {(item) => {
        const stats = () =>
          [
            ["input / 1M", perMillion(item().price?.input ?? null)],
            ["output / 1M", perMillion(item().price?.output ?? null)],
            ["cached input / 1M", perMillion(item().price?.cacheRead ?? null)],
            ["context", item().contextTokens ? compactCount(item().contextTokens!) : undefined],
            ["coding index", item().score === null ? undefined : String(item().score)],
            [
              "measured",
              item().observed
                ? item().observed!.range
                  ? formatMarketRange(item().observed!.range!)
                  : formatMarketAmount(item().observed!.usd)
                : undefined,
            ],
            [
              "accepted",
              item().observed
                ? item().observed!.terminal
                  ? `${item().observed!.accepted} of ${item().observed!.terminal}`
                  : String(item().observed!.accepted)
                : undefined,
            ],
          ].filter((row): row is [string, string] => row[1] !== undefined)
        return (
          <>
            <p class="lazers-models-source-line">{entryProvenanceText(item())}</p>
            <Show when={stats().length > 0}>
              <dl class="lazers-models-stats" aria-label="Selected model facts">
                <For each={stats()}>
                  {([label, value]) => (
                    <div>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  )}
                </For>
              </dl>
            </Show>
            <Show when={basis()}>
              {(text) => (
                <p class="lazers-models-basis-line">Your median accepted task: {text()}</p>
              )}
            </Show>
            <Show when={item().providers}>
              {(providers) => (
                <p class="lazers-models-source-meta">Available via {providers().join(", ")}</p>
              )}
            </Show>
            <Disclosure
              title="Estimate basis and prices"
              hint={item().price ? benchmarkSourceName[item().price!.source] : undefined}
            >
              <Show when={catalogSummary()}>
                {(summary) => <p>Model set: {catalogSummaryText(summary())}.</p>}
              </Show>
              <p>
                List prices times the median tokens per accepted task across our{" "}
                {profile()?.configurations ?? 0} observed configurations (
                {profile()?.acceptedTasks ?? 0} accepted tasks).
                {item().projection?.cacheAtInputRate
                  ? " This model lists no cache rate, so cached tokens are priced at its input rate."
                  : ""}
              </p>
              <For each={catalogNotes()}>{(note) => <p>{note}.</p>}</For>
              <Show when={scoreBasis().source === "epoch"}>
                <p>
                  Score: {scoreBasis().caption}. {epochCoverageLine()}
                </p>
                <Show when={(epochCoverage()?.unmatched.length ?? 0) > 0}>
                  <details class="lazers-models-sources-details">
                    <summary>Benchmark names not matched to a catalog model</summary>
                    <For each={epochCoverage()?.unmatched ?? []}>
                      {(unmatched) => (
                        <p class="lazers-models-source-meta">
                          {unmatched.name} · {unmatched.reason}
                        </p>
                      )}
                    </For>
                  </details>
                </Show>
              </Show>
              <SourcesDetails ctl={props.ctl} />
            </Disclosure>
          </>
        )
      }}
    </Show>
  )
}

/** The pane's source warnings, one short line each. */
function sourceWarningLines(ctl: ModelsController) {
  const { sourceWarning, visible } = ctl
  return [
    ...ctl.catalogNotes().map((note) => `${note}.`),
    sourceWarning()?.message,
    visible()?.tasksError && `Task list unavailable: ${visible()?.tasksError}`,
    visible()?.sourceRefreshError && `Source refresh error: ${visible()?.sourceRefreshError}`,
    visible()?.comparisonError && `Comparison read error: ${visible()?.comparisonError}`,
  ].filter((line): line is string => Boolean(line))
}

/** Compare mode inspector: the selected model, laid out by the details-pane spec. */
function CompareInspector(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const {
    Ui,
    status,
    compareMode,
    comparisonSource,
    observedConfigurationFor,
    openContributorTrajectory,
    priceSourceOrder,
    selectedBenchmark,
    selectedFacts,
    heldInspection,
    showObservedFor,
    state,
    visible,
  } = ctl
  const sources = () => visible()?.comparison?.sources ?? []

  return (
    <section
      class="lazers-models-inspector-compare"
      data-panel-dimmed={visible()?.decisionInspectLoading ? "true" : undefined}
      role="tabpanel"
      id="lazers-models-compare-panel"
      aria-labelledby="lazers-models-compare-tab"
    >
      <Show when={compareMode() === "projected"}>
        <ProjectedSummary ctl={ctl} />
      </Show>
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
            const model = createMemo(() =>
              benchmarkPaneModel({
                route: entry().route,
                scores: entry().benchmark,
                price: entry().price,
                citation:
                  comparisonSource("openrouter-benchmarks")?.snapshot?.citation ?? undefined,
                snapshot: comparisonSource("openrouter-benchmarks")?.snapshot ?? undefined,
                priceSourceName: entry().price
                  ? benchmarkSourceName[entry().price!.source]
                  : undefined,
                order: priceSourceOrder()
                  .sources.map((source) => benchmarkSourceName[source])
                  .join(", then "),
                mix: BENCHMARK_PRICE_MIX,
                sources: sources(),
                warnings: sourceWarningLines(ctl),
              }),
            )
            return (
              <BenchmarkModelPane
                model={model()}
                action={
                  <Show when={observedConfigurationFor(entry().route)}>
                    <div>
                      <Ui.Button
                        size="small"
                        variant="ghost-muted"
                        onClick={() => showObservedFor(entry().route)}
                      >
                        Show observed cost
                      </Ui.Button>
                    </div>
                  </Show>
                }
              />
            )
          }}
        </Show>
      </Show>
      <Show when={compareMode() === "observed"}>
        <Show
          when={ctl.selectedDecisionConfiguration()}
          fallback={
            <Show when={status.view().kind === "ready" && visible()?.decisionOverview}>
              <p class="lazers-models-note">Select a model on the chart.</p>
            </Show>
          }
        >
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
            {(inspection) => {
              const model = createMemo(() =>
                observedPaneModel({
                  inspection: inspection(),
                  facts: selectedFacts(),
                  sources: sources(),
                  warnings: sourceWarningLines(ctl),
                }),
              )
              return (
                <ObservedModelPane
                  Ui={Ui}
                  model={model()}
                  onTrajectory={openContributorTrajectory}
                  moreBusy={visible()?.decisionContributorsLoading}
                  onMore={ctl.moreContributors}
                />
              )
            }}
          </Show>
        </Show>
      </Show>
    </section>
  )
}

/** The pane's one line: model name, exact route and Assign. Also the collapsed pane. */
function compareDetails(ctl: ModelsController) {
  const {
    Ui,
    assignDisabled,
    assignMenuItems,
    assignRoute,
    assignSelectedRoute,
    compareMode,
    decisionModelFullName,
    decisionModelLabel,
    filterPersona,
    personas,
    selectedBenchmark,
    selectedDecisionConfiguration,
    catalogEntries,
  } = ctl
  const projected = () =>
    compareMode() === "projected"
      ? catalogEntries().find((item) => item.id === ctl.selectedEntryID())
      : undefined
  const selected = () =>
    compareMode() === "projected"
      ? projected()
      : compareMode() === "benchmark"
        ? selectedBenchmark()
        : selectedDecisionConfiguration()
  const header = () => {
    if (!selected()) return undefined
    return (
      <Show when={projected()} fallback={<ObservedOrBenchmarkHeader />}>
        {(item) => (
          <span class="lazers-models-selected-identity">
            <h2>{boundedModelLabel(item().label)}</h2>
            <code>
              {item().route.providerID}/{item().route.modelID}
            </code>
            <Show when={item().projection}>
              {(projection) => (
                <span class="lazers-models-selected-price">
                  <strong>{formatMarketAmount(projection().usd)}</strong> projected per accepted
                  task
                </span>
              )}
            </Show>
          </span>
        )}
      </Show>
    )
  }
  const ObservedOrBenchmarkHeader = () => {
    return (
      <Show
        when={compareMode() === "benchmark" ? selectedBenchmark() : undefined}
        fallback={
          <Show when={selectedDecisionConfiguration()}>
            {(configuration) => (
              <span class="lazers-models-selected-identity">
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
              </span>
            )}
          </Show>
        }
      >
        {(entry) => (
          <span class="lazers-models-selected-identity">
            <h2
              title={routeLabel(entry().route)}
              aria-label={`Selected model ${entry().label}. Exact route ${routeLabel(entry().route)}.`}
            >
              {boundedModelLabel(entry().label)}
            </h2>
            <code>
              {entry().route.providerID}/{entry().route.modelID}
            </code>
          </span>
        )}
      </Show>
    )
  }
  const actions = () => {
    const entry =
      compareMode() === "benchmark"
        ? selectedBenchmark()
        : compareMode() === "projected"
          ? projected()
          : undefined
    const configuration = compareMode() === "observed" ? selectedDecisionConfiguration() : undefined
    if (!entry && !configuration) return undefined
    return (
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
              items={
                entry
                  ? assignMenuItems(() => ({ ...entry.route, variant: null }))
                  : personas().map((persona) => ({
                      label: persona.personaLabel,
                      onSelect: () => assignSelectedRoute(persona.persona),
                    }))
              }
            />
          </span>
        }
      >
        {(persona) => (
          <Ui.Button
            size="small"
            disabled={assignDisabled()}
            onClick={() =>
              entry
                ? assignRoute(persona().persona, { ...entry.route, variant: null })
                : assignSelectedRoute(persona().persona)
            }
          >
            {`Assign to ${persona().personaLabel}`}
          </Ui.Button>
        )}
      </Show>
    )
  }
  return { header, actions }
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
  const details = compareDetails(props.ctl)
  return (
    <SplitPane
      solo={solo()}
      ctl={props.ctl}
      empty="No model selected"
      detailsHeader={details.header()}
      detailsActions={details.actions()}
      header={props.header}
      top={<CompareTop ctl={props.ctl} />}
      bottom={<CompareInspector ctl={props.ctl} />}
    />
  )
}
