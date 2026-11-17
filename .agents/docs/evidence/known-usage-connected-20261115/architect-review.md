# Architect review: connected known-usage gate

The plan remains blocked on its combined connected review. Accepted workers and
their passing task/combined receipts are preserved; reconciliation found no
pending effects. No worker replay, source repair, or acceptance is warranted by
the findings below.

## Pricing-policy reconciliation

The probe accurately recorded `configured-current-market` for all three exact
configurations. This is not an endpoint-selection regression. Later integrated
work deliberately changed production pricing to the configured ordered sources,
with whole-model fallback and no source splicing. The endpoint calculator remains
for callers without configured sources.

Architect inspected the current branch in `src/models/decision-read.ts:1247-1266`
and the reviewed integration history in
`design/reviews/lz173-0b28972-source-review-20261107.md` and
`design/reviews/lz173-canonical-integration-20261107.md`. The latter records retained
`ddefc44`/`0b28972` ancestry through `19d62a63`/`1981d7ae`. These successor changes
explain native catalog Kimi/Qwen quotes and the Luna model-average envelope.
Do not restore preferred endpoint IDs or graft Kimi's endpoint-scoped write zero
onto another quote merely to match historical implementation guidance.

Endpoint evidence retention, useful conservative valuations, provenance/coverage
disclosure, and actual connected UI observations remain separate acceptance
questions. Later pricing integration does not itself close this older gate.

## Scoped visual review

Terra High reviewed actual captures 01-06. The observed default-width Qwen
inspector passes readability, containment, chart/inspector separation, amount,
provenance and caveat presentation. Captures demonstrate lower scrolling while
the chart remains fixed. The stills do not independently establish upper scrolling;
the probe's native observation supplies only that reported behavior. Architect
also inspected capture 04 and agrees with its scoped amount/caveat finding.

This is not acceptance of wide geometry or unobserved Kimi/Luna selection and
disclosure interactions. Loaded server/GUI revision remains unknown; the probe
confirmed the active local plugin path, live API identity, and source ancestry,
not an exact loaded-module commit.

## Concrete remaining blocker

Capture 07 shows a new macOS request for OpenCode to bypass the private window
picker and directly access screen and audio. No permission was granted. The
native probe stopped; the outer window was restored, while Models/Qwen remains
selected and the panel widened. No more native input or capture should occur
until the user resolves that security decision.

After an authorized resolution, complete unobstructed wide/default geometry,
fresh Kimi/Luna exact-route selection and disclosures, then obtain scoped visual
review and record only the combined evidence actually established. Do not mark
the gate passed solely to remove its missing-evidence hold.
