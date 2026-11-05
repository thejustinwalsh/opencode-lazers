# LZ-134 compact Architect notifications — implementation evidence

## Behavior covered

- Predecessor input and assistant-result metadata remains in the durable progressive source journal. Native notification payloads use a compact source-change pointer, not per-ID batches. The pointer text directs the current Architect to page the journal and retrieve only selected original messages.
- Selected-message reads require the current plan owner and an active same-project Architect. The native adapter reads only the requested message from the validated same-project client, redacts secret-like strings, omits metadata, reasoning, tools, and attachments, and bounds visible text. Journal completeness and native consumption remain explicitly unknown.
- Explicit legacy reconciliation is current-owner authorized and bounded to 20 outstanding legacy rows per call. It establishes a compact pointer for every current owner, verifies exact pointer ownership and native queued/consumed observation, claims each legacy outbox row, then cancels only positively owned still-queued notices. Original payloads, message IDs, and admission receipts are retained. Foreign metadata, missing/unavailable native reads, cancellation errors, and lost responses remain recoverable unknown/deferred states. Successful cancellation is recorded only after native readback confirms absence; consumption races are recorded as consumption.
- Regression coverage exercises disjoint equal-revision batches, multiple retained sources/current-owner routing, bounded continuation, concurrent reconciliation, owner changes during native awaits, API unavailability and retry, store reopen/claim replacement, cancellation response loss, cancellation-versus-consumption, independent outcome state/receipt preservation, same-owner admitted no-op delivery, and unrelated native user input.

## Compact-growth fixture

`src/runner/store.test.ts` uses a bounded disposable SQLite fixture, with no transcript-body copies. The first fixture contains 804 input rows and 3,839 assistant-result rows (4,644 total journal records including the source metadata record). The second adds another 804 inputs and 3,839 results, mutating an existing result to a later revision rather than inserting an extra result, for 9,287 total journal records. Both snapshots are traversed page-by-page to verify old IDs and changed result revisions remain discoverable.

The fixture serializes the durable handoff and source-pointer text and measures UTF-8 bytes for (a) a stable synthetic inbox envelope (`id`, `type`, `delivery`, and `payload` text/metadata), and (b) the exact stable input object passed by the host adapter to `session.synthetic` (session, ID, text, metadata, resume, delivery, description). These byte counts exclude dynamic native timestamps, HTTP framing, model tokenization, usage, and cache effects.

| Fixture                    | Handoff text | Pointer text | Combined text |      Stable inbox envelopes |  `session.synthetic` inputs | Notices | Current pointers | Journal records |
| -------------------------- | -----------: | -----------: | ------------: | --------------------------: | --------------------------: | ------: | ---------------: | --------------: |
| 804 inputs / 3,839 results |        880 B |        572 B |       1,452 B | 1,388 B + 1,164 B = 2,552 B | 1,450 B + 1,226 B = 2,676 B |       2 |                1 |           4,644 |
| Doubled input/result rows  |        880 B |        572 B |       1,452 B | 1,388 B + 1,164 B = 2,552 B | 1,450 B + 1,226 B = 2,676 B |       2 |                1 |           9,287 |

The journal retains 201 each of pending, steering, and unknown inputs at the first size and 402 each at the doubled size. A changed assistant result reaches revision 2 in the doubled fixture while its ID is absent from pointer text. Text and inbox-envelope sizes do not scale with historical row count.

## Verification and limits

- `bun test src/runner test/runner` — 450 tests passed across 25 files (6,163 assertions) on the final candidate after compact-notification expectation updates.
- `bun run verify` — Bun formatter, linter, and type checker passed.
- `git diff --check` — passed.
- Focused compact-growth, reconciliation, schema/tool-routing, selected-message privacy, and store-reopen tests passed.

These are source-level fixture and unit-test measurements, not native token counts, cache measurements, usage estimates, or guaranteed savings. Root's exact-candidate native observation of inbox/receipt sizes, progressive retrieval, current-owner routing, and cancellation readback is still outstanding; no task acceptance is claimed here.
