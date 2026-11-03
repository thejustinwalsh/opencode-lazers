# Live source-adapter review

2026-11-02 · Root review of LZ-77 artifact `8ebdce9`.

## What actually ran

At Unix ms `1793655529974`, the candidate's actual `ModelEvidenceRefresher`
processed real native model-list and OpenRouter responses into a disposable DB.
The configured OpenRouter key was resolved through the public client credential
API, kept in memory, and sent only to OpenRouter. No inference call or production
DB write occurred. Native plugin connection resolution was represented by that
key: this is **adapter behavior**, not registered RPC or GUI acceptance.

| Source                                    | Actual response      | Candidate result                        |
| ----------------------------------------- | -------------------- | --------------------------------------- |
| Native catalog                            | 470 records          | succeeded, 470 retained                 |
| OpenRouter models                         | HTTP200, 415 records | failed: malformed-response; no snapshot |
| Artificial Analysis coding via OpenRouter | HTTP200, 152 records | succeeded, 152 retained                 |

Disposable DB and files were removed after the run. Runnable review helper:
`/private/tmp/lazers-model-source-live-review.ts`.

## Isolated defect

The live catalog includes variable-price routing entries whose published prompt
or completion quote is negative. Observed IDs: `typesafe/jev-router`,
`nvidia/switchyard`, `openrouter/auto-beta`, `openrouter/fusion`,
`openrouter/pareto-code`, `openrouter/bodybuilder`, `openrouter/auto`.

The candidate's nonnegative decimal parser throws for `-1`, aborting the entire
catalog. A focused source fixture with the same `openrouter/auto` record fails
when price is `-1` and succeeds when that price is null. The actual module was
called; no DB state or result was manufactured. Helper:
`/private/tmp/lazers-source-price-review.ts`.

Keep such routes visible with honest variable/unknown pricing and source
provenance. Do not turn sentinel prices into negative costs, zero/free prices,
or a failure of all valid catalog records. Preserve schema/privacy safeguards
without rejecting normal public metadata. Repeat a real safe metadata refresh
after correction; mocked positive-price records did not cover this failure.

Root's other source finding for LZ-78 is in
[route ownership review](route-ownership-review-20261102.md). Neither finding
is a file hash, a model approval, or native product acceptance.

## Prepared correction and reprobe

The first `-1` correction alone did not make the full feed succeed. A per-row
review of the same real catalog isolated three further failures: MiniMax
`minimax/minimax-m3.1-flash` and Tencent `tencent/hy4-preview` / `tencent/hy3`
publish overrides with `utc_start` and `utc_end`, without `min_prompt_tokens`.
The candidate incorrectly required a context threshold for every override.

Root prepared [this three-file correction](openrouter-source-correction.json)
against the exact returned source, in a disposable source-review directory.
The active artifact and native task state were not edited. It maps the observed
`-1` quote to unknown, preserves normal/explicit-zero quotes, and retains raw
published UTC markers separately from context thresholds. No clock interpretation
or scheduled-price calculation is invented; the inspected API docs do not explain
those markers. [Auto pricing](https://openrouter.ai/pricing) confirms routed
model charges, so an unavailable router quote must not become a free estimate.

Both added regressions failed before their respective fixes. Corrected source:
11 source/store tests, 65 assertions; strict typecheck of five files; lint of
three changed files; formatting clear, using pinned Bun1.4.4-canary.1.

A second full real reprobe at Unix ms `1793656457077` succeeded for **all three
sources**:470 native models,415 OpenRouter models,152 coding benchmark records.
Each used HTTP200 or the native model API; disposable DBs were cleaned. The
registered plugin/RPC path and Desktop remain unproven. Apply/review this patch
through the native workflow after Desktop unlock; do not assert it is integrated.

The correction artifact stores the exact unified diff in its JSON `patch` field;
write that field to a temporary file and check/apply it against the stated base.

## Source integration — 2026-11-03

While Desktop remained locked, Root integrated the native artifact in fff7644
and applied the prepared real-feed correction as 17a5582. Main now passes all
24 Models tests / 203 assertions, strict checking and lint. This includes the
registered-handler fixtures, not a live registered RPC observation. The prior
real metadata reprobe remains adapter evidence. Native task acceptance, runtime
activation and the approved comparison UI remain open; no task DB or worker tree
was changed.
