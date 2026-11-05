# Models live review

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
