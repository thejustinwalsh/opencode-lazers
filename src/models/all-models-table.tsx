import { For, Show } from "solid-js"
import { benchmarkSourceName, compactTokenAxisValue } from "./chart-data.ts"
import { entryCost, sourceTagLabel } from "./catalog-projection.ts"
import type { CatalogEntry } from "./catalog-projection.ts"
import { formatMarketAmount, formatMarketRange } from "./comparison-presentation.ts"

const date = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" })

/** Cost per task: the measured range for an observed model, the projection otherwise. */
export function entryCostText(entry: CatalogEntry) {
  if (entry.observed)
    return entry.observed.range
      ? formatMarketRange(entry.observed.range)
      : `≈${formatMarketAmount(entry.observed.usd)}`
  const cost = entryCost(entry)
  return cost === null ? "" : `≈${formatMarketAmount(cost)} projected`
}

export function entryPriceText(entry: CatalogEntry) {
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
              <th scope="col">Cost per task</th>
              <th scope="col">Tokens</th>
              <th scope="col">Accepted</th>
              <th scope="col">Score</th>
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
                      aria-label={`Select ${entry.label}, rank ${rank() + 1}`}
                      onClick={() => props.onSelect(entry)}
                    >
                      {entry.label}
                    </button>
                  </th>
                  <td>{entry.tags.map((tag) => sourceTagLabel[tag]).join(" · ")}</td>
                  <td>{entryCostText(entry)}</td>
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
                  <td>{entry.score ?? ""}</td>
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
