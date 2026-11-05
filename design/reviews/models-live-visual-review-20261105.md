# Models live review

## Remaining logical-task accounting gap

Read-only production inspection on November5 confirmed the saved correction
link LZ-124 (`b2f262ab-bbe7-476b-9437-3bfe22edabdd`) to LZ-119
(`8d324858-260e-48b9-bc7c-1825666717e4`), revision1. Both physical tasks and
their histories are intentionally retained. The current decision producer adds
accepted physical task UUIDs to `acceptedTaskIDs`, uses that set's size as the
denominator and builds accepted retry histories from sessions for that UUID
alone. It does not consume the existing `readTaskCorrections` projection.
Its contract nevertheless labels the result accepted logical tasks and complete
logical-task retry history. This source/data mismatch needs a small follow-up;
it does not establish the magnitude of the live chart's resulting distortion.

Reuse explicit correction membership, preserve physical attempt history and
avoid counting one original goal twice. Define how cross-model correction
effort and outcomes are attributed before presenting a model comparison as
complete. Unknown attribution should stay visible. Verify against a linked
accepted original/correction pair and reprobe the connected product. Keep this
separate from active122 pricing and146 visual corrections and preserve the
overdue Tasks/Trajectory/Radar order.

## Current connected observation

Correction `5a34617` passed independent native Luna review and was merged as
`8c1b161`. Root current-main verification passed160 tests/2511 assertions plus
formatting, lint, typechecking and diff checks. Authenticated production rows at
1793912948665 now return null market USD/task for all3 configurations: the
false-zero defect is fixed in the real handler. The price index still has no
applicable pins; usable pricing remains unresolved, despite exact cached model
records. Do not equate null costs with successful market-price availability.

The connected panel subsequently timed out, including a Refresh retry. Its
transport applies a fixed8000ms deadline to every operation in
`comparison-panel.tsx`; the successful direct production probe allows20000ms.
This identifies a concrete deadline discrepancy, not a complete performance
diagnosis. Source/decision reload churn is also previously observed. Preserve
these in the existing UI-state/performance lane, without broadening146's visual
scope or treating the app timeout as proof of a pricing semantic regression.

The Data volume reached131MiB free while an image capture failed. Root removed
four unopened, old investigation-only SQLite snapshot copies from `/private/tmp`
after checking handles; free space became992MiB. Production DBs, worker source,
logs and model files were preserved. Disk pressure is an observed environmental
problem; causation of the panel timeout is not established.

Root integrated LZ-122 `04fe393` as `3a07387` after158 current-main tests/2477
assertions, formatting, lint and typechecking. Independent native Luna review
continued in parallel. The actual Desktop Compare now renders cohorts and an SVG
graph; this supersedes the missing-registration finding below.

Native authenticated `ModelsDecision.rows` at1793909241550 returned price-index
source unavailable, no pins, unavailable freshness and null current-price fields
for every row. OpenRouter was configured; OpenCode pricing was not configured.
Nevertheless Qwen and Luna efficiencies contained numeric zero market USD/task
with missing-current-price flags, and Desktop plotted them as $0.00. That is a
real product failure, not valid free pricing. Architect attached the observation
and resumed the original122 worker for a targeted correction and regression.
Supported complete zero must remain distinct from unavailable or partial totals.

Fresh cached OpenRouter data contains all three exact model records and their
published rates. The producer's `collectRoutes` currently supplies only routes,
omitting usage and tier applicability used by `current-price-index.ts`. Root
relayed this separate availability finding without inventing usage zeros or a
context tier. Real configured pricing still needs qualification.

Connected captures: `/private/tmp/lz122-models-first-live-20261105.png` and
`/private/tmp/lz122-models-first-live-wide-20261105.png`. Native Tera High session
`ses_e52a5ae04ffeObat8Bt6imz4ci` reviewed all three requested images against the
approved reference. Its completed report is retained at
`/private/tmp/lz122-terra-compare-review-20261105.txt`. Remaining visual corrections:

- Compact the narrow controls/chart so selectable rows fit above the default split.
- Format large axis values and bound point labels to prevent wide collisions.
- Reuse authoritative model names and lead the inspector with a concise estimate;
  keep detailed accounting/provenance in collapsed evidence.

The native Architect recorded LZ-145 for this correction. Its execution-phase
assumption leaked into the specification; Root requested a corrected same-goal
record before dispatch, rather than an override-policy paragraph. UI implementation
is authorized on Luna Max with actual scope reservations, separately from122's
pricing correction and57's retained-work recovery. Final visual acceptance remains
unproven. Root restored the narrow panel after both captures.

## Earlier missing-producer observation

Approved reference: `design/models-panel/models-approved.png`. Actual Desktop
captures: `/private/tmp/lazers-models-assignments-live-20261105.png` and
`/private/tmp/lazers-models-compare-live-20261105.png`.

At Unix milliseconds `1793871782124`, a read-only call to the production decision
overview RPC returned: `RPC is unavailable: lazers.models.decision.v2`.
`src/models/decision-contract.ts` defines that contract; the panel calls it in
`src/models/comparison-panel.tsx`. Current canonical source contains no server
registration for this contract. This is a missing producer integration, not a
successful comparison with no matching models. Reconcile existing LZ126→LZ122
work before adding new work. Do not fabricate chart points to cover the failure.

Tera screenshot review identified these corrections against the approved image:

- Restore the compact cohort toolbar; disclose source/route diagnostics on demand.
- Show one actionable error, with diagnostic detail collapsed; normalize raw
  `[object Object]` errors. The capture does not establish classification's final
  outcome.
- Put the chart and candidate rows above the horizontal split, with selected
  model estimate, contributing trajectories and collapsed evidence below.
  Stack chart above rows at narrow widths; place them beside each other when wide.
- Replace expanded persona blocks with compact assignment rows and one selected
  editor. Collapse mapping layers and revision history.
- Deliver assignment editing and actual dispatch resolution. Current saved
  mappings are read-only and explicitly say routing is inactive.

Keep native OpenCode theme/fonts, closable tabs, split and scrolling. Producer
repair must precede assessment of real chart points, rows and estimates. This is
a read-only product observation and design review; no model settings, pricing
refresh, inference settings or running workers were changed.
