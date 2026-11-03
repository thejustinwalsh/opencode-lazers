# Models comparison implementation guide

Use [models-approved.png](models-approved.png) for composition and [DESIGN.md](../../DESIGN.md) for shared panel behavior. The developer is comparing routes for a task, then choosing whether to assign one. Compare is the primary view; Assignments is secondary. The image's values and smooth curve are illustrative, not product data.

## Panel composition

- Keep a continuous native surface with a compact Models header, project scope, refresh, Compare/Assignments tabs, and wrapping persona, explicit task-class and cohort/time controls. Show the accounting basis near the comparison. Use actual available filter values; distinguish loading, empty, partial, stale and failed reads.
- Above a horizontal, resizable divider, put the token-versus-comparable-cost chart above candidate rows at 330–450 CSS px; at wide widths put chart and table side by side. Rows remain a complete keyboard-accessible alternative to the chart, including unplottable candidates and unknown values. Align selection between row and point with a non-color cue, and retain accepted/terminal counts and coverage. Use tabular numerals and readable host-sized text.
- Below the divider, the selected route inspector leads with model/provider/effort and the selected task's projected market-equivalent range when supported. Show its cohort size, coverage and uncertainty; otherwise show unavailable. Link contributing trajectories, keep evidence, source dates and assumptions collapsed, and offer a compact assignment action. The panes scroll independently and preserve selection, split and scroll across refresh. Keep the routing-not-active warning visible for assignment until dispatch integration actually exists.
- Use mean tokens and comparable cost per completed logical task, with acceptance quality beside each candidate. A frontier applies only to comparable, quality-eligible observations; connect only actual nondominated eligible points without extrapolation. Distinguish observed LAZERS results, external evidence and projections; do not turn missing metrics into zero or an automatic rank. Separate dated market-equivalent prices from actual charges and allowances.

## Existing building blocks

Use `ctx.ui` menus, buttons, icon buttons and text inputs, and the optional closable panel pattern in [Tasks](../../src/tasks/panel.tsx). Its keyboard-accessible separator and scroll restoration, and [Radar's presentation helpers](../../src/radar/presentation.ts), provide established interaction patterns. Use inherited host font and semantic tokens; `ctx.appearance.font("mono")` is reactive for exact IDs. Keep long identities accessible and full evidence in disclosures. The chart must have a complete textual alternative and visible focus.

[Models RPC](../../src/models/contract.ts) already exposes saved settings/configure, advisory native catalog, source evidence and refresh. [Source schemas](../../src/models/source-schema.ts) preserve source-specific records and freshness; [trajectory accounting](../../src/trajectory/accounting.ts) and [history](../../src/trajectory/history.ts) provide foundations for task effort and lineage. These are foundations, not an existing comparison or estimate API: add a bounded read projection where required rather than deriving authoritative cohorts in the view. Resolve exact route/source identity explicitly; unavailable mappings, prices and attribution stay unknown. Preserve existing revision-conflict and uncertain-write handling when the secondary editor is connected.

## Chart implementation

Use Apache ECharts 6.1.0 through a small Solid component, with modular imports
and `SVGRenderer`. Scatter points, a separate line series for the actual frontier,
grid/axes, labels and tooltips cover this design. Keep point, row and inspector
selection connected. Let the chart manage coordinates and label layout; keep
cohort, valuation and frontier decisions in the data projection.

Map native semantic colors and the host font into chart options, including live
appearance changes. Resize with the panel and dispose chart/listeners on unmount.
Preserve a complete keyboard-accessible table alternative. Render actual valid
observations even for one sample; the concept's smooth curve is not a function
to fit or extrapolate.

Current comparisons revalue recorded usage using the current shared pricing
lookup, with OpenRouter as the market index. Retain retrieval time and source
semantics. Historical price snapshots are audit records, not the valuation basis
for today's graph. Actual charges remain separate from market-equivalent cost.

Checked 2026-11-03 against official [modular import guidance](https://echarts.apache.org/handbook/en/basics/import/)
and [SVG renderer guidance](https://echarts.apache.org/handbook/en/best-practices/canvas-vs-svg/).
Published npm metadata lists ECharts6.1.0 with `zrender`/`tslib` dependencies.
Unovis1.7.1 also supplies a Solid adapter compatible with this project's Solid1.9,
but its core installation includes mapping and 3D dependencies. Observable Plot
offers SVG marks and pointer interactions; ECharts is the selected fit for the
linked comparison interactions and label management.

## Increment and verification boundaries

Reuse the integrated source snapshots and accounting. Architect can specify small remaining increments: resolve exact route/source identity and coverage; project comparable historical cohorts; expose a task estimate with assumptions and insufficient-data states; then connect the comparison panel to those reads. Specify assignment editing and live per-attempt resolution separately against the existing mapping contract. Each increment should expose genuine partial data and have its own acceptance boundary.

Verify connected OpenCode Desktop at narrow and wide widths against the approved image: all controls reachable, plot and rows readable, matching selection and selected inspector, independent scroll and divider resize, keyboard operation, and theme/font changes. Exercise unavailable/partial/stale evidence and assignment conflict or uncertain-write recovery. Check that refresh preserves the view and that values, provenance and trajectory links match real records. Automated checks and the concept do not establish native visual acceptance.
