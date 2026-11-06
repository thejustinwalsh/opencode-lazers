# Models LZ-169 source review — 6 November 2026

Root inspected the active worker's changes before delivery. This is separate from
the required Desktop/Tera visual acceptance.

## Naming collision requiring correction

`modelDisplayLabel` selects provider ID as the disambiguator whenever matching
catalog names span providers. It does not distinguish two different models from
one provider within that mixed set.

A read-only call to the actual worker module reproduced this case; every route
has catalog name `Shared catalog name` and a null effort variant:

| Provider   | Model   | Returned label                   |
| ---------- | ------- | -------------------------------- |
| provider-a | model-a | Shared catalog name · provider-a |
| provider-b | model-b | Shared catalog name · provider-b |
| provider-a | model-c | Shared catalog name · provider-a |

The first and third routes collide. Distinguish them with real catalog/route
metadata, preserving the catalog name and exact route in accessible details.
Cover the mixed-provider set with a duplicate name within one provider in the
existing presentation tests. This fits LZ-169's naming scope; no new feature or
provider policy is needed.

Reproduction: `/private/tmp/lz-label-review-probe.ts`, importing the active
`f6c063ba-695f-4f41-8101-42d9ef57321e` worker's
`src/models/comparison-presentation.ts`. Root sent the result through Desktop to
Architect to attach focused advice and steer the current worker. Delivery,
correction, regression results and final source acceptance must be revalidated.

## Combined preparation

The independent integration candidate `79c748c` merges delivered LZ-163, LZ-168
and LZ-155 with their original commit ancestry. It excludes this still-active
LZ-169 work. Its source passed 733 tests / 10,360 assertions, formatting, lint,
typecheck and GUI build. No new source was activated in Desktop. Those results
do not establish visual fidelity or prove the pending naming correction.
