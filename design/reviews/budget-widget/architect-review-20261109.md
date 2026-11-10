# Budget widget review — 2026-11-09

Reviewed candidate `0fce8146213b3de8e1dea7ec98ae0c8eda5902d5` against the
latest configured-key `/key` forward-baseline requirement. The original
unavailable-only OpenRouter wording is superseded, not an acceptance target.

## Findings requiring repair

The independent read-only review found two multi-client defects:

- `src/budget/server.ts:50–64` binds the shared cached loader's fetch and storage
  to its first caller's signal. Cancelling that caller aborts work still needed
  by another coalesced reader.
- `src/budget/server.ts:55` stores one baseline per key, while
  `src/budget/openrouter.ts:65–73` resets on timezone/period mismatch. Two clients
  in different timezones sharing a server/key can repeatedly erase each other's
  baseline instead of accumulating useful deltas.

Advice 3 requests one coherent correction with registered-RPC cancellation and
alternating-timezone/persistence regressions in the original retained worker.
The normal retained-repair command was rejected **before reservation** with
“Retained repair worker's accepted input is no longer its completed current
turn.” The native history contains a background-shell completion synthetic input,
then the candidate's final response and genuine idle. This is not evidence of
user cancellation, nor permission to forge input/idle or manually replace the
worker. Architect is investigating the supported recovery/root lifecycle fix.

No merge, integration or cleanup is claimed.

## Rendered evidence

Architect launched the candidate's real-module visual harness through the
existing Portless installation at `https://lazers-budget.localhost:1355/` and
retained `rendered-fixture-20261109.jpeg` alongside this note. It shows:

- monthly Go 60% with muted yellow ring;
- compact rolling Go over 100% with muted red ring;
- light/dark OpenRouter `$181*` from fixture credit $120.4 plus BYOK $60.2;
- neutral dash on first observation;
- a narrow settings card with no visible horizontal clipping.

The rendered accessible descriptions include both Go periods/reset times and
OpenRouter's rounded components, configured-key/since-baseline coverage, local
Sunday interval and configured denominator. The fixture uses representative
theme tokens and a mock host tooltip/switch. It does **not** prove real native
context-widget adjacency, native tooltip geometry, or nonzero live spend.

The existing live probe returned provider-reported Go monthly 20%/rolling 0%
and valid zero OpenRouter counters. Candidate runtime quality, 12 behavior tests
(112 assertions), GUI build and read-only live checks passed before the review
findings; they do not establish the new regressions are fixed.

Only the fixture launched for this review was stopped through its identified
Portless parent process. The background command terminated with signal 143 and
its identified parent/child were absent afterward. Shared proxy/trust, original
worker worktree/session and the separately owned Desktop verifier were preserved.

## Integration boundary

Compose the budget import/registration additions rather than replacing
`src/index.ts`: current main contains newer `registerToolCallWrappers` wiring
absent from the candidate's baseline. GUI wiring is additive. Review the repaired
candidate and coherent combination before recording runtime integration and
requesting normal non-forced cleanup.

## Follow-up — integrated 2026-11-10

Repaired candidate `c4ed688e571da4995149197f16314c1a4ea7592d` removes the value
asterisk, supplies concise structured JSX tooltip lines, separates shared backend
operation lifetime from caller cancellation, and persists independent
configured-key/timezone baselines. Registered regressions exercise first-caller
cancellation, last-reader cancellation and alternating-timezone reads across
registration restarts. Review found no remaining blocker in these paths.

The current-main composition preserved tool-call wrapper wiring and passed
`bun run verify`, **14 budget tests / 130 assertions**, and GUI build. Combined
context/budget checks then passed **96 tests / 691 assertions**; the advanced
Tasks rendering test passed **1 test / 121 assertions**. Main fast-forwarded to
`5124b9e0b6d38942d7a3a0276fb667a340b86e50` at a quiet native execution boundary,
and its GUI bundle was rebuilt successfully. Existing live-provider receipts were
retained rather than repeated. Actual native tooltip geometry is still not
established by the mock-host rendering test; no such visual claim is made.

Runtime integration and completed native worktree removal/cache eviction were
observed. Fresh native inventory, Git registration and filesystem checks confirmed
the worker checkout absent, with no matching attempt-named branch. Native
interrupt reported the worker already inactive; archive timestamp was read back.
History and committed source remain. The merged Architect composition checkout
was removed separately through the native API with `force:false`.
