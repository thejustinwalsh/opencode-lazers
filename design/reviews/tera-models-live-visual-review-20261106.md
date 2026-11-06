# Native Tera Models visual review

Reviewer: OpenAI gpt-6.1-terra/high, session ses_e52a5ae04ffeObat8Bt6imz4ci.
Received three inline PNGs through the native Architect delegation.

Implementation authority: current [DESIGN.md](../../DESIGN.md) incorporates the
user's subsequent correction: full-width chart, tooltips and brief selected cost,
details below, no right-hand table or internal review copy. It supersedes the
layout and copy suggestions in this original review.

## Verdict: visual acceptance fails

I viewed all three requested images: `/private/tmp/lz-models-live-narrow-first.png`, `/private/tmp/lz-models-live-wide-first.png`, and `design/models-panel/models-approved.png`. I also inspected source at `d1b0c5f` and `DESIGN.md`.

The real plotted view is materially less compact than the approved composition. In the narrow capture, the chart and its legend consume the upper pane and the divider cuts through the first row. In the wide capture, **Accepted** breaks across lines and each cost cell becomes a tall provenance paragraph. Both charts show truncated raw route IDs. The inspector stacks empirical, reference and scenario cards ahead of task context and trajectories.

## Small source-grounded repair plan

1. **Restore compact comparison rows.** In `src/models/comparison-panel.tsx:2046–2123` and `comparison-panel.css:237–330`, give the Accepted column enough width to stay on one line and replace each repeated cost/provenance paragraph with a compact, clearly qualified value or unknown state. Move detailed reference basis and provenance to the selected inspector’s evidence disclosure. Preserve the visible distinction between canonical cost and a partial priced subtotal—never present the latter as a complete cost. Keep full precision and meaning accessible.

2. **Make chart plus rows fit the narrow first view.** In `comparison-panel.css:382–450, 1379–1396` and `comparison-chart.tsx:607–662`, compact the plot’s surrounding heading, legend and disclosure footprint while retaining a readable plot, distinct mark meanings and accessible chart-data alternative. Use the existing narrow stack and wide side-by-side layout; at the normal narrow split, multiple complete rows should be visible without scrolling. Do not shrink host fonts or change panel geometry to achieve it.

3. **Use readable chart identities.** `comparison-chart.tsx:356–385` truncates `point.label`, which is currently a raw route label. Reuse the exact catalog-backed display-name logic in `comparison-panel.tsx:1013–1020` and `comparison-presentation.ts:204–226` **when an authoritative exact match is available**. Keep full route and exact values in tooltip/accessibility text, and fall back truthfully when metadata is unavailable. A display-only label must not replace or infer global graph coordinates, identities or explicit nulls; `comparison-panel.tsx:1044–1062` is a particular preservation point for off-page data.

4. **Re-establish one primary inspector estimate.** In `comparison-panel.tsx:2209–2249, 2276–2391, 2548–2563`, lead with model/provider/effort, then one prominently labelled empirical estimate or honest unavailable state, selected-task context and trajectory action. Place the separate OpenRouter reference and known-usage scenario under initially collapsed evidence, retaining concise visible qualifications wherever a value is shown: scalar versus range, partial subtotal/remainder unknown, freshness and basis. Keep exact route controls available but secondary; preserve disclosure state and all detailed evidence.

**Likely write scope:** `src/models/comparison-panel.tsx`, `comparison-panel.css`, `comparison-chart.tsx`, optionally `comparison-presentation.ts`, and focused existing panel/chart/presentation tests. No pricing, accounting, routing, global graph projection, refresh architecture or GPU changes. Main should choose the existing appropriate task or small linked correction; the prior LZ-146 no-point clearance remains valid only for that earlier state.

## Focused validation after correction

- Connected narrow and wide captures with **real plotted data**: legible labels and ticks, intact mark distinctions, no broken header, compact rows, and multiple complete narrow rows above the unchanged split.
- Exercise row/point/inspector selection, off-page selection, keyboard access, split and independent scroll, disclosure persistence, native theme/font changes and refresh.
- Test scalar, conditional range, partial subtotal, unknown, stale and explicit-null cases; confirm provenance remains accessible and global graph/paging/refresh behavior is unchanged.

The approved image’s values and curve are illustrative, not data to reproduce. These screenshots establish the visual failure, not completion or the cause of any runtime/GPU issue.
