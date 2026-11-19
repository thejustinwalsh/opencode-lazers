# Models comparison implementation guide

> Superseded for the details panes by [design/details-panes/spec.md](../details-panes/spec.md) and `DESIGN.md`. The mockup images this document links to (`tasks-focus-v2.png`, `models-approved.png`, `models-compare-v*.png`, `models-focus-v*.png`, `trajectory-review-v2.png`) were abandoned and removed on 2026-11-19; those links no longer resolve.

Use [models-approved.png](models-approved.png) for composition and [DESIGN.md](../../DESIGN.md) for shared panel behavior. The developer is comparing routes for a task, then choosing whether to assign one. Compare is the primary view; Assignments is secondary. The image's values and smooth curve are illustrative, not product data.

## Panel composition

- Keep a continuous native surface with a compact Models header, project scope, refresh, Compare/Assignments tabs, and wrapping persona, explicit task-class and cohort/time controls. Show the accounting basis near the comparison. Use actual available filter values; distinguish loading, empty, partial, stale and failed reads.
- Above a horizontal, resizable divider, put the token-versus-comparable-cost chart above candidate rows at 330–450 CSS px; at wide widths put chart and table side by side. Rows remain a complete keyboard-accessible alternative to the chart, including unplottable candidates and unknown values. Align selection between row and point with a non-color cue, and retain accepted/terminal counts and coverage. Use tabular numerals and readable host-sized text.
- Below the divider, the selected route inspector leads with model/provider/effort and the selected task's projected market-equivalent range when supported. Show its cohort size, coverage and uncertainty; otherwise show unavailable. Link contributing trajectories, keep evidence, source dates and assumptions collapsed, and offer a compact assignment action. The panes scroll independently and preserve selection, split and scroll across refresh. Keep the routing-not-active warning visible for assignment until dispatch integration actually exists.
- Use attributable cohort tokens and current market-equivalent cost from the selected price source divided by accepted logical tasks, including the cohort's failed work and retries in the numerator. Show acceptance counts and measurement coverage beside each exact configuration. There is no arbitrary acceptance-rate or sample-size threshold. Zero-acceptance configurations stay visible without a successful-task efficiency coordinate. A frontier connects only actual nondominated points with compatible, supported accounting bases; do not extrapolate or substitute benchmark scores for our outcomes. Raw provider accounting is optional historical diagnostic evidence, not a product cost or a prominent subscription-accounting view.

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

Read reactive chart inputs before a nonreactive mount guard so later data-only
changes stay subscribed. Verify updated SVG geometry and selection, not only
the parallel textual controls. Keep model labels literal in HTML tooltips.

Product cost records, comparisons and estimates revalue recorded usage using the
ordered price-source setting, independent of execution provider or subscription.
Initially offer OpenRouter and OpenCode, in that default order, reusing configured
OpenCode access. Skip unavailable sources; if none supplies an applicable price,
show unavailable. OpenCode fallback uses published catalog rates, not recorded
session charges. Preserve missing rates and explicitly published zeros correctly.
Retain the chosen source, retrieval time and source
semantics. Historical price snapshots are audit records, not the valuation basis
for today's graph. Actual charges remain separate from market-equivalent cost.

An applicable [published OpenRouter caching rule](https://openrouter.ai/docs/guides/best-practices/prompt-caching#moonshot-ai)
may establish a zero cache-write rate with applicability and retrieval provenance;
an omitted API field alone is not zero. Model-specific published quotes take
precedence over generic multipliers. Select native catalog rates only through the
configured OpenCode source; do not mix providers silently or average endpoint
quotes without a defined basis.

OpenCode's native `model.list` exposes `Model.Info.cost` tiers in USD per million
tokens: input, output, cache read/write, with optional context thresholds.
The pinned [session cost implementation](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/usage.ts)
prefers endpoint-reported `Usage.cost`, otherwise calculates from catalog rates,
and returns zero when no rate exists. Use the catalog for the OpenCode price
source, not that session total. Observed OpenAI subscription catalog entries have
empty cost arrays; preserve that missing-data state.

Refreshing the common price index must revalue the same historical usage and
task estimates without changing that usage. Preserve the source's exact quote
or average semantics; catalog quotes are not an observed endpoint average.
The estimate range is empirical observed spread across accepted logical-task
histories, each including its own retries, not predictive confidence. Label this
sample basis separately from the failure-inclusive aggregate above; do not assign
failed-only task effort arbitrarily to accepted samples. One observation is one
value with `n = 1`, not an invented interval.

## Task-type cohorts

The Architect assigns one primary task kind from a versioned controlled catalog
as part of task definition. Classify by objective and acceptance boundary, not
persona, files touched or eventual outcome. Historical immutable tasks need
explicit authored classification annotations; missing classification remains
visible, never silently inferred.

The proposed `task-kind/v1` catalog is `bug-repair`, `feature-implementation`,
`refactoring`, `testing`, `documentation` and `maintenance`. This is a compact,
benchmark-informed repository taxonomy, not a universal industry standard.
[SWE-Lancer](https://arxiv.org/html/2502.12115v3#A1.SS1) distinguishes bug fixes,
features/enhancements and maintenance/QA/testing/reliability;
[SWE-PolyBench](https://github.com/amazon-science/SWE-PolyBench#datasets) explicitly
includes refactoring. Testing is a primary-deliverable specialization;
documentation is a local extension. Keep build, CI, dependencies and tooling
inside maintenance initially. A feature or repair that includes tests retains
its feature or repair kind.

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
