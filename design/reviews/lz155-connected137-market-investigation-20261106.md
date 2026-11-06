# LZ-155 connected LZ-137 market-value investigation

**Read-only investigation, 2026-11-06.** No implementation, tests, UI actions, inference, or changes to settings, cache, or databases. LZ-155 remains unresolved; this note does not accept it. The checkout is at `eb89c51`, descended from `fab6bfe`; the inspected trajectory/valuation/panel files are unchanged between those revisions.

## Retained LZ-137 evidence

The live `lz-inspect-trajectory` result identifies task `0f6bb558-101b-4d57-a9d9-80428df78fce`, attempt `359a7178-f7d2-472d-8a10-a13b969f1a95`, session `ses_fa6c346c44b04d5c9de8f895674664ed`, and the exact admitted/current/observed route `openai / gpt-6-luna / max`. Session snapshot usage is uncached input **56,452**, cache read **820,992**, cache write **0**, output **2,061**, reasoning **2,202**. There are 19 observed step routes, all the same route; route allocation is single-observed, not mixed. The legacy scalar 881,707 is explicitly retained but not added to these categorized totals.

The same live result reports market cost `status: partial`, `valueUSD: null`, `subtotalUSD: 0`; one session is unpriced/partial, with no selected source and `freshness: unknown`. Positive uncached-input, cache-read, output, and reasoning categories are `unknown` with null values. Only cache-write is `zero-usage` at $0 because its observed token count is zero. Thus the subtotal is the zero contribution of a genuinely observed zero-usage category—not a zero rate for the positive usage, not a supported published free price, and not a total.

## Why no cached quote was selected

The project has no saved `models.price-source-policy.<encoded project path>` value in OpenCode’s `kv` store, so `ModelPriceSourceSettingsStore` uses its default ordered policy: OpenRouter, then OpenCode, with whole-model fallback (`src/models/price-source-settings.ts:76-85`). The OpenRouter credential metadata is active; its secret value was not read. Read-only model evidence rows show both source refreshes succeeded at generation 167. The cached OpenRouter record exactly matches the route’s product `openai/gpt-6-luna` and has two prompt tiers: base, and `minPromptTokens: 272000`; all published rates in both tiers are positive. The matching native-catalog record is present but has `prices: null`.

The producer builds one applicability from the session route and category usage (`src/models/valuation.ts:1002-1023`); it supplies no OpenRouter prompt-tier selector. `chooseOpenRouterTier` deliberately returns no tier when prompt tiers exist but that selector is absent (`src/models/current-price-index.ts:140-183`, especially 153). The ordered selector then tries OpenCode, but `nativePin` returns no pin for a matching record without prices (`src/models/current-price-index.ts:251-263`; source order/fallback at 423-477). This is conservative applicability, not a stale/missing OpenRouter snapshot. The prompt selector represents a **per-call** prompt tier (`src/models/market-range.ts:415-433`); the task valuation sees a cumulative session snapshot and 19 step routes, not a selector for each call. Inferring a per-call tier from the session total would invent applicability and could price calls in the wrong tier.

With no pin, positive token categories stay unknown (`src/models/valuation.ts:770-805`). The observed zero cache-write category contributes 0, so the correct partial known subtotal is 0 while the total stays null (`src/models/valuation.ts:858-910, 935-989`). Empty selected pins also explain `currentIndex.sources: []` and unknown freshness: `currentPriceIndexFreshness` reports unknown when there are no pins (`src/models/task-valuation.ts:109-126`), not because the cached generations are stale.

## User-visible defect and smallest correction

The registered trajectory producer passes this valuation through `inspectTrajectory` (`src/index.ts:125-145`, `src/trajectory/read.ts:1172-1183`). In the actual panel, `displayedMarketCost` falls back to any non-null subtotal, including zero, when the total is null (`src/trajectory-panel/panel.tsx:982-1005`). It therefore renders **“API equivalent · partial” / “$0 subtotal”** while positive usage is unpriced and no source was selected. The nearby source note helps, but does not make `$0 subtotal` safe as the primary value.

Keep the existing valuation math and unknown statuses. In the panel, do not render `$0` as a subtotal when the total is unknown and positive usage remains unpriced; show an explicit unavailable/no-priced-subtotal value and state that positive usage is unpriced. Keep a positive known subtotal labeled as a subtotal, never as the total. Preserve `$0` for a complete observed zero-usage total and for a complete quote whose applicable published rates are genuinely zero. Do not fix this by selecting an OpenRouter tier from session-aggregate usage.

## Discriminating regression behavior

Exercise the public trajectory path (`lz-inspect-trajectory`/Observability valuation producer) and the registered Trajectory panel’s rendered cost row, rather than only testing `projectTaskValuation`:

1. Reproduce LZ-137: positive usage plus observed zero cache-write, no applicable pin, `valueUSD: null`, `subtotalUSD: 0` → the panel must not show `$0` as the API-equivalent cost; it must say positive usage is unpriced.
2. Ordered fallback: an inapplicable tiered OpenRouter quote falls through to a fully applicable OpenCode quote; if the native record has no price, retain unknown usage and no pin. Never splice rates across sources or treat absent rates as zero.
3. Partial priced + unknown sessions → null total and an explicitly labeled positive priced subtotal.
4. Complete observed zero usage with no price → known $0 zero-usage total; a complete supported published all-zero-rate quote for positive usage → known $0 priced total. These must remain distinct from case 1.
5. A tiny positive known value must format as nonzero, not round/render as `$0`.

**Confidence:** high for the retained token/route/cost facts and rendering path; high that the cached OpenRouter tier has no selector in this producer and the native fallback has no price. The ordered policy default is confirmed by the absent project setting; credential status was checked only through non-secret active metadata, not by directly invoking the host integration-status API. No implementation or tests were run.
