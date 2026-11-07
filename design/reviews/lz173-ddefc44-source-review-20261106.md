# LZ-173 `ddefc44`: independent source review

Independent read-only Luna review against `ef1a881`; Architect confirmed the
identified source branches. Actual Desktop LZ-137 acceptance remains open.

## Findings

1. **P1 — amount and provenance can come from different valuations.**
   `trajectory-panel/panel.tsx:992–1000` chooses existing `apiCost()` before
   `observedUsageEstimate`, while the row label and source summary prefer the
   estimate (`:1013–1020, 1065–1070`). A strict index can fall back to priced
   OpenCode when OpenRouter needs a per-call selector, while the new observed-call
   estimate validly selects OpenRouter. The headline then displays the OpenCode
   amount under an OpenRouter estimate label. The fixture with empty index pins
   misses this branch. Test distinct simultaneously present amounts and assert
   headline amount, label, source and basis all describe one selected valuation.
2. **P2 — unused-tier missing rates veto usable observed-call prices.**
   `models/market-range.ts:383–389` checks every tier for all positive categories
   before per-call selection. The reviewer's focused no-listener probe removed
   only the unused override's cache-read rate: all 19 LZ-137 calls still select
   the fully priced base tier, but the configured result loses its scenario.
   Evaluate applicability against actually relevant call/tier evidence; do not
   invent a rate/bound when an unknown tier is genuinely relevant. Preserve
   configured whole-model fallback and honest partial/range semantics.
3. **P2 — Models hardcodes endpoint provenance for configured scenarios.**
   `decision-read.ts:1242–1253` now provides native-catalog and OpenRouter model
   catalog scenarios. `comparison-panel.tsx:394–398, 422–426` still calls all of
   them “OpenRouter endpoint” / “OpenRouter endpoint pricing.” Render the actual
   source kind and supplied provenance, including the endpoint case where valid.

## Ownership and verification

Findings 1–2 stay in original LZ-173's existing Trajectory/shared-pricing scope,
using a substantive same-worker retained repair. Finding 3 belongs to LZ-172's
existing Models presentation scope, not an unannounced expansion of LZ-173 into
the held UI worker's files. Attach it there for the same worker after LZ-174's
supported recovery is activated. Root's corrected combination must include that
consumer fix before claiming accurate Models provenance; RPC-only checks are
insufficient. No replacement workers or manual repair of live task state.

Exact `ddefc44` task and graph checks passed pricing **83 tests / 842 assertions**,
Trajectory **71 / 537**, GUI build and quality. These passes do not refute the
uncovered branches. The reviewer ran the focused no-listener probe and diff
check, not broad suites; no product/test/settings/cache/database files changed.
Preserve the useful observed-usage estimate contract: recovery gaps qualify
secondary assumptions, not a blanket price veto. No unavailable prose, invented
rates, source splicing, false zero or exact-billing prerequisite.
