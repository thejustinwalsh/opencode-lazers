import { For, Show } from "solid-js"
import { benchmarkSourceName, compactTokenAxisValue } from "./chart-data.ts"
import { sourceTagLabel } from "./catalog-projection.ts"
import type { CatalogEntry } from "./catalog-projection.ts"
import { COST_BASIS_LABEL, costConfigurationLabel, costText } from "./configuration-cost.ts"
import type { ConfigurationCost } from "./configuration-cost.ts"

const date = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" })

/**
 * The row's name: a model row whose observed facts came from one configuration names it
 * ("GPT-6 Luna · max"); the model's other observed efforts are in the "Your runs" chart.
 */
function entryRowLabel(entry: CatalogEntry) {
  return entry.observed && entry.observed.cost.kind !== "none"
    ? costConfigurationLabel(entry.label, entry.observed.cost)
    : entry.label
}

/** A stored cost cell: its text and basis; nothing at all when no source prices it. */
function CostCell(props: { cost: ConfigurationCost | null | undefined }) {
  return (
    <td>
      <Show when={costText(props.cost)}>
        {(text) => (
          <span
            class="lazers-models-cost"
            data-basis={props.cost!.basis}
            data-kind={props.cost!.kind}
            data-low={props.cost!.low}
            data-high={props.cost!.high}
            title={COST_BASIS_LABEL[props.cost!.basis]}
          >
            {text()}
          </span>
        )}
      </Show>
    </td>
  )
}

function entryPriceText(entry: CatalogEntry) {
  if (!entry.price) return ""
  const when = entry.price.retrievedAt ? Date.parse(entry.price.retrievedAt) : Number.NaN
  return [benchmarkSourceName[entry.price.source], Number.isFinite(when) ? date.format(when) : ""]
    .filter(Boolean)
    .join(" · ")
}

/**
 * "All models · N": the full, keyboard-reachable alternative to the plot, ranked with the best
 * trade-off first and then by cost per task. A row selects its point.
 */
export function AllModelsTable(props: {
  entries: readonly CatalogEntry[]
  selectedID: string | null
  onSelect: (entry: CatalogEntry) => void
}) {
  return (
    <details class="lazers-models-disclosure lazers-models-all-models">
      <summary>
        <span>All models</span>
        <span class="lazers-models-disclosure-hint">{props.entries.length}</span>
      </summary>
      <div class="lazers-models-all-models-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Source</th>
              <th scope="col" title={`${COST_BASIS_LABEL.observed}, per accepted task`}>
                Observed / task
              </th>
              <th scope="col" title={`${COST_BASIS_LABEL.projected}, per accepted task`}>
                Projected / task
              </th>
              <th scope="col">Tokens</th>
              <th scope="col">Accepted</th>
              <th scope="col" class="lazers-models-score-cell">
                Score
              </th>
              <th scope="col">Prices</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.entries}>
              {(entry, rank) => (
                <tr data-frontier={entry.frontier ? "" : undefined}>
                  <th scope="row">
                    <button
                      type="button"
                      data-entry-id={entry.id}
                      data-configuration-id={entry.observed?.configurationID}
                      aria-pressed={props.selectedID === entry.id}
                      aria-label={`Select ${entryRowLabel(entry)}, rank ${rank() + 1}`}
                      title={entryRowLabel(entry)}
                      onClick={() => props.onSelect(entry)}
                    >
                      {entryRowLabel(entry)}
                    </button>
                  </th>
                  <td>{entry.tags.map((tag) => sourceTagLabel[tag]).join(" · ")}</td>
                  <CostCell cost={entry.observed?.cost} />
                  <CostCell cost={entry.projected} />
                  <td>
                    <Show when={entry.observed?.tokens != null}>
                      {compactTokenAxisValue(entry.observed!.tokens!)}
                    </Show>
                  </td>
                  <td>
                    <Show when={entry.observed}>
                      {(observed) =>
                        observed().terminal
                          ? `${observed().accepted}/${observed().terminal}`
                          : `${observed().accepted}`
                      }
                    </Show>
                  </td>
                  <td class="lazers-models-score-cell">{entry.score ?? ""}</td>
                  <td>{entryPriceText(entry)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </details>
  )
}
