import { For, Show } from "solid-js"
import type { ModelsController } from "./models-controller.ts"
import { benchmarkSourceName } from "./chart-data.ts"

/** The stream-backed, keyboard-operable editor for the price policy. */
export function PriceSourceControls(props: { ctl: ModelsController }) {
  const ctl = props.ctl
  const Ui = ctl.Ui
  return (
    <section class="lazers-models-price-order" aria-label="Price source order">
      <h3>Price source order</h3>
      <p>Move sources to choose which applicable price is used first.</p>
      <Show
        when={ctl.priceSourceOrder().configured}
        fallback={
          <p role={ctl.priceSourceError() ? "alert" : "status"} class="lazers-models-source-meta">
            {ctl.priceSourceError()
              ? `Price order unavailable: ${ctl.priceSourceError()}`
              : "Loading price order…"}
            <Show when={ctl.priceSourceError()}>
              <Ui.Button size="small" variant="ghost-muted" onClick={ctl.retryPriceSourcePolicy}>
                Retry
              </Ui.Button>
            </Show>
          </p>
        }
      >
        <ol class="lazers-models-price-order-list" aria-label="Configured price sources">
          <For each={ctl.priceSourceDraft()}>
            {(source, index) => {
              const name = benchmarkSourceName[source]
              return (
                <li class="lazers-models-price-order-row">
                  <span>
                    <strong>{index() + 1}.</strong> {name}
                  </span>
                  <span class="lazers-models-price-order-actions">
                    <Ui.IconButton
                      size="small"
                      variant="ghost-muted"
                      icon="arrow-up"
                      label={`Move ${name} up`}
                      disabled={ctl.priceSourceBusy() || index() === 0}
                      onClick={() => ctl.movePriceSource(source, -1)}
                    />
                    <Ui.IconButton
                      size="small"
                      variant="ghost-muted"
                      icon="chevron-down"
                      label={`Move ${name} down`}
                      disabled={
                        ctl.priceSourceBusy() || index() === ctl.priceSourceDraft().length - 1
                      }
                      onClick={() => ctl.movePriceSource(source, 1)}
                    />
                  </span>
                </li>
              )
            }}
          </For>
        </ol>
        <div class="lazers-models-price-order-actions">
          <Ui.Button
            size="small"
            variant="contrast"
            disabled={!ctl.priceSourceCanSave()}
            busy={ctl.priceSourceBusy()}
            onClick={ctl.savePriceSourceOrder}
          >
            Save order
          </Ui.Button>
          <Ui.Button
            size="small"
            variant="ghost-muted"
            disabled={!ctl.priceSourceDirty() || ctl.priceSourceBusy()}
            onClick={ctl.revertPriceSourceOrder}
          >
            Revert
          </Ui.Button>
          <Show when={ctl.priceSourceFeedback()}>
            {(feedback) => (
              <span
                class="lazers-models-price-order-feedback"
                data-status={feedback().status}
                role={
                  feedback().status === "conflict" || feedback().status === "failed"
                    ? "alert"
                    : "status"
                }
                aria-live={
                  feedback().status === "conflict" || feedback().status === "failed"
                    ? "assertive"
                    : "polite"
                }
              >
                {feedback().message}
              </span>
            )}
          </Show>
        </div>
        <Show when={ctl.priceSourceError()}>
          <p class="lazers-models-price-order-error" role="alert">
            Price order stream: {ctl.priceSourceError()}
            <Ui.Button size="small" variant="ghost-muted" onClick={ctl.retryPriceSourcePolicy}>
              Retry
            </Ui.Button>
          </p>
        </Show>
      </Show>
    </section>
  )
}
