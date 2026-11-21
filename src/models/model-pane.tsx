import { For, Show } from "solid-js"
import type { JSX } from "solid-js"
import {
  Coverage,
  Disclosure,
  Identifiers,
  Label,
  Row,
  Rows,
  Section,
  StatRow,
} from "../details/index.ts"
import type { ModelDecisionContributor } from "./decision-contract.ts"
import type { ModelsController } from "./models-controller.ts"
import type {
  BenchmarkPaneModel,
  Headline,
  IdentifierItem,
  ObservedPaneModel,
  SourceRow,
  TokenRow,
} from "./pane-presentation.ts"

/**
 * The selected-model pane body (design/details-panes/spec.md): one headline figure, a stat row,
 * a coverage bar, flat rows, then Tokens, Sources, Caveats and Identifiers. Props are plain values
 * prepared by `pane-presentation.ts`; nothing here reads the controller.
 */

/** The one figure the pane leads with, its unit, and a `small sample` label when it applies. */
function HeadlineFigure(props: { headline: Headline }): JSX.Element {
  return (
    <div class="lazers-models-headline">
      <span class="lazers-models-headline-value">{props.headline.value}</span>
      <span class="lazers-models-headline-unit">{props.headline.unit}</span>
      <Show when={props.headline.smallSample}>
        <span class="lazers-models-headline-label">
          <Label tone="warning">small sample</Label>
        </span>
      </Show>
    </div>
  )
}

function SourcesDisclosure(props: {
  rows: SourceRow[]
  warnings?: readonly string[]
}): JSX.Element {
  return (
    <Disclosure label="Sources" count={props.rows.length}>
      <Rows columns="minmax(0, 1.5fr) minmax(0, 1fr) auto" label="Sources" items={props.rows}>
        {(row) => (
          <Row>
            <span title={row.name}>{row.name}</span>
            <span class="lazers-models-row-weak">{row.detail}</span>
            <span class="lazers-models-row-weak">{row.time}</span>
          </Row>
        )}
      </Rows>
      <For each={props.warnings ?? []}>{(line) => <p class="lazers-models-caveat">{line}</p>}</For>
    </Disclosure>
  )
}

function CaveatsDisclosure(props: { lines: readonly string[] }): JSX.Element {
  return (
    <Disclosure label="Caveats" when={props.lines.length > 0}>
      <For each={props.lines}>{(line) => <p class="lazers-models-caveat">{line}</p>}</For>
    </Disclosure>
  )
}

function IdentifiersDisclosure(props: { items: readonly IdentifierItem[] }): JSX.Element {
  const shown = () => props.items.filter((item) => item.value)
  return (
    <Disclosure label="Identifiers" when={shown().length > 0}>
      <Identifiers items={shown()} />
    </Disclosure>
  )
}

function TokensDisclosure(props: { rows: TokenRow[] }): JSX.Element {
  const hasCoverage = () => props.rows.some((row) => row.coverage)
  const hasRate = () => props.rows.some((row) => row.rate)
  const columns = () =>
    `minmax(0, 1fr) auto${hasCoverage() ? " 96px" : ""}${hasRate() ? " 72px" : ""}`
  const header = () => [
    "Kind",
    "Tokens",
    ...(hasCoverage() ? ["Coverage"] : []),
    ...(hasRate() ? ["Rate / 1M"] : []),
  ]
  return (
    <Disclosure label="Tokens" count={props.rows.length}>
      <Rows columns={columns()} header={header()} label="Tokens by kind" items={props.rows}>
        {(row) => (
          <Row>
            <span>{row.kind}</span>
            <span class="lazers-models-row-num">{row.tokens}</span>
            <Show when={hasCoverage()}>
              <span class="lazers-models-row-weak">{row.coverage}</span>
            </Show>
            <Show when={hasRate()}>
              <span class="lazers-models-row-num">{row.rate}</span>
            </Show>
          </Row>
        )}
      </Rows>
    </Disclosure>
  )
}

/** Your runs, one model. */
export function ObservedModelPane(props: {
  model: ObservedPaneModel
  onTrajectory: (contributor: ModelDecisionContributor) => void
  moreBusy?: boolean
  onMore: () => void
  Ui: ModelsController["Ui"]
}): JSX.Element {
  const Ui = props.Ui
  const model = () => props.model
  return (
    <div class="lazers-models-pane-body">
      <Show when={model().headline}>{(headline) => <HeadlineFigure headline={headline()} />}</Show>
      <StatRow stats={model().stats} />
      <Show when={model().coverage}>
        {(coverage) => (
          <Coverage
            priced={coverage().priced}
            unpriced={coverage().unpriced}
            caption={coverage().caption}
            note={coverage().note}
          />
        )}
      </Show>
      <Show when={model().runs.length > 0}>
        <Section label="Runs" aside={<span>{model().runTotal}</span>}>
          <Rows
            columns="64px minmax(0, 1fr) 56px 64px auto"
            header={["Task", "Outcome", "Tokens", "Cost", ""]}
            label="Runs with this model"
            items={model().runs}
          >
            {(run) => (
              <Row>
                <span class="lazers-models-row-mono">{run.task}</span>
                <span>{run.outcome}</span>
                <span class="lazers-models-row-num">{run.tokens}</span>
                <span class="lazers-models-row-num">{run.cost}</span>
                <Ui.Button
                  size="small"
                  variant="ghost-muted"
                  aria-label={`Open trajectory for ${run.task}`}
                  onClick={() => props.onTrajectory(run.contributor)}
                >
                  Trajectory
                </Ui.Button>
              </Row>
            )}
          </Rows>
          <Show when={model().hasMoreRuns}>
            <div>
              <Ui.Button size="small" variant="ghost" busy={props.moreBusy} onClick={props.onMore}>
                Load more runs
              </Ui.Button>
            </div>
          </Show>
        </Section>
      </Show>
      <div class="lazers-models-pane-disclosures">
        <TokensDisclosure rows={model().tokens} />
        <SourcesDisclosure rows={model().sources} warnings={model().sourceWarnings} />
        <CaveatsDisclosure lines={model().caveats} />
        <IdentifiersDisclosure items={model().identifiers} />
      </div>
    </div>
  )
}

/** Benchmark, one model. */
export function BenchmarkModelPane(props: {
  model: BenchmarkPaneModel
  action?: JSX.Element
}): JSX.Element {
  const model = () => props.model
  return (
    <div class="lazers-models-pane-body">
      <Show when={model().headline}>{(headline) => <HeadlineFigure headline={headline()} />}</Show>
      <StatRow stats={model().stats} />
      {props.action}
      <div class="lazers-models-pane-disclosures">
        <Disclosure label="Scores" count={model().scores.length}>
          <Rows columns="minmax(0, 1fr) auto" label="Scores" items={model().scores}>
            {(row) => (
              <Row>
                <span>{row.name}</span>
                <span class="lazers-models-row-num">{row.detail}</span>
              </Row>
            )}
          </Rows>
        </Disclosure>
        <SourcesDisclosure rows={model().sources} warnings={model().sourceWarnings} />
        <CaveatsDisclosure lines={model().caveats} />
        <IdentifiersDisclosure items={model().identifiers} />
      </div>
    </div>
  )
}
