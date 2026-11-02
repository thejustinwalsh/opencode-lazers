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
