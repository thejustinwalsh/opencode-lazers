# Models visual refinement

## Approved implementation reference

The user selected [models-approved.png](models-approved.png), the exact attached
image originally saved as `models-compare-v1.png`. This supersedes v2 as the
visual target. Preserve its focused narrow/wide hierarchy: comparison and filters,
chart plus candidate rows, horizontal split, selected-model estimate and trajectory
link, collapsed evidence and a compact assignment action. Assignments remains
secondary. Use native OpenCode fonts and reactive theme tokens.

Retain the data and accessibility findings from Tera's reviews: real comparable
cohorts, honest missing data, sourced cost estimates, an accessible table and a
non-color selected-point cue. The illustrative curve and numeric examples are
not implementation data. Review actual connected narrow/wide screenshots against
this approved image; do not redesign the composition from the older editor.

## Product purpose

The user explicitly rejected and cancelled the old Models editor UI task and
its Desktop qualification. Preserve useful backend work/history, supersede the
obsolete UI target, and build the reviewed comparison direction. The owned trial
was stopped and cleaned through supported cleanup; no saved mapping/readback was
established. Do not resume testing that screen. Public entry is `/lz-models`,
under the requested `lz-*` command/tool namespace, rather than bare `/models`.

Models is primarily a model-selection decision surface: task/persona comparison,
historical outcomes, sourced benchmarks/prices, Pareto efficiency and projected
task cost. Assignment editing is secondary. The first two concepts below cover
only that secondary editor; they do not satisfy the full Models feature.
Use `../../DESIGN.md` and the Phase 2 research for the full accounting contract.

Use available live APIs for source data. With OpenRouter configured, it is the
default fallback index for pricing, benchmark evidence and useful model metadata.
Reuse the configured native credential, keep source-specific fields/dates and
refresh asynchronously over retained observations. This is independent of the
execution provider. Do not substitute static model claims where an API can
provide the current fact, or turn a metadata fetch into an inference call.

## Current connected UI review

Tera 6.1 High compared the actual owned Models panel with `tasks-focus-v2.png`.
One persona occupies almost the entire wide pane. Nested shared/project/effective
cards, long paths, revision mechanics and the always-open form hide the other
assignments. This fails the compact row/disclosure hierarchy.

Target: all three persona rows visible together, showing saved model/effort and
inheritance, with one selected editor below. Narrow controls stack; wide rows
align. Collapse technical details; keep unresolved conflicts and uncertain-write
recovery visible. Retain a concise routing-not-active notice and manual routes.
Preserve the existing operation ledger, readback and conflict semantics.

## References

- `../task-panel/tasks-focus-v2.png`: continuous surface and focused rows.
- `../trajectory-panel/trajectory-review-v2.png`: upper overview, lower inspector.
- `../system-panel/system-timeline-v3-narrow.png`: narrow horizontal split.
- `../system-panel/system-flow-v1.png`: visual family only; older graph semantics
  do not replace the current C4-style Radar direction.
- `../../DESIGN.md`: current shared interface direction.

`models-focus-v1.png` is a built-in imagegen concept with illustrative assignments,
not a screenshot or acceptance proof. Review is in progress. Its wide overview
incorrectly duplicates editing controls that belong only in the lower editor.

Tera's round-one review also requested a persistent concise routing warning,
explicit editing layer/removal semantics and manual IDs within the selected
editor. `models-focus-v2.png` incorporates those changes. Both remain editor
concepts, not the primary comparison view.

## Live source check — 2026-11-02

Read-only metadata calls (no inference) are saved in
`market-read-20261102.json`: OpenRouter `/api/v1/models` returned HTTP200,
451 records; the saved subset contains 92 relevant GPT/Qwen/GLM/Sonnet entries.
The unauthenticated `/api/v1/benchmarks` call returned HTTP401. Benchmark ingestion
requires configured authorized OpenRouter access; do not invent benchmark values
or treat catalog ordering as a numeric score. This snapshot is research data,
not an implemented refresh/cache/DB feature. Listed catalog prices are not an
observed average across endpoint prices or a measured task cost.

Sources: [models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
[benchmarks API](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks).

At Unix ms `1793653317222`, Main's registered Models catalog RPC returned in
24ms: 470 native options, 446 with price metadata. Configured implementor was
`openai/gpt-6-luna#max`. These are advisory catalog observations, not measured
task costs, external benchmark scores, or proof of an individual worker route.

## Primary comparison concept

`models-compare-v1.png` restores comparison as the primary view. Tera reviewed
its narrow/wide composition against Tasks and Trajectory: filters, plot plus
candidate rows, horizontal split, selected task estimate and secondary assignment.
All numeric examples in this image are illustrative, not historical observations.
The next round corrects the extrapolated smooth frontier, inconsistent evidence
shapes/values, incomplete text alternative and missing unknown-history case.

Tera reviewed `models-compare-v2.png`; the user subsequently chose v1's composition
as the implementation reference above.
The selected plot point also needs a non-color selection cue. Actual code must
define comparable cohorts/quality eligibility, derive estimate ranges/confidence
from data, preserve unknown routes and expose source freshness/coverage. Raster
example values are never product defaults or benchmark results.

Following the user's OpenRouter login, an authorized metadata read at Unix ms
`1793653475233` returned HTTP200 with 152 Artificial Analysis coding records,
source-as-of `2026-11-02T12:00:09.958Z`, saved in
`benchmarks-read-20261102.json`. The key was obtained via OpenCode's supported
credential API and used only in memory for the OpenRouter request; no inference
was requested. Public source scores are not LAZERS task results or estimates.

Further authorized API reads returned HTTP200 for Design Arena UI-component
(157 records) and data-visualization (154) results, plus OpenRouter's own
evaluation results (315). `benchmark-sources-read-20261102.json` retains the
public source-specific records and dated provenance. These are result counts,
not unique model counts. UI Elo/win rate, coding indices and evaluation accuracy
are different measures; do not combine them into an unexplained universal score.

## Implementation boundaries for Architect

Root's returned-artifact reviews found two concrete defects:
[LZ-77 actual API catalog rejection](../../.agents/docs/evidence/models-accounting/source-live-review-20261102.md)
and [LZ-78 cross-attempt route ownership](../../.agents/docs/evidence/models-accounting/route-ownership-review-20261102.md).
The first adapter run retained 470 native records and 152 coding benchmarks,
but rejected the successful OpenRouter models response because of dynamic-price
sentinels. Correct these before claiming the corresponding data paths complete.

Reuse existing queued work and useful LZ-68 backend behavior, replacing its rejected
editor composition. Specify small increments
for source observations/identity mapping; historical cohorts/accounting and task
estimates; the comparison view; and live persona assignment resolution at dispatch.
These are boundaries to decompose, not four prewritten epic-sized tasks. Keep
the comparison mission visible while individual increments expose real partial
data. Each live feature needs connected observations, not just this concept.
