# LZ-155: market estimates must remain useful

Root review of `lz155-connected137-market-investigation-20261106.md` and the actual LZ-137 Desktop capture. The investigation establishes the false-zero presentation and why strict tier selection produces no quote. Its proposed UI-only correction is insufficient for the user's requested product.

The user explicitly wants current OpenRouter market pricing even for subscription runs, accepts estimates, and prefers omitting a truly unavailable amount over displaying “Cost unavailable.” Published matching tiered rates are available here. Missing exact per-call attribution must not make ordinary market estimates unusable.

Architect should incorporate this into the existing pricing repair: use the configured source order and published matching rates to produce a clearly labeled current-market estimate or range when exact tier attribution is absent. Preserve exact amounts where supported and explain estimate assumptions in collapsed detail. Do not present cumulative session usage as a per-call tier selector, invent rates, or use historical subscription charges. Omit a genuinely unpriced amount; never display the observed zero cache-write contribution as the cost of positive unpriced usage.

Reuse the existing pricing and range owners where appropriate. `src/models/market-range.ts` already calculates amounts across published schedules and returns a range for unresolved attribution (approximately lines 704–828; exported entry `calculateKnownUsageMarket`). This is a source starting point, not a prescription to create a second valuation system. Reconcile Trajectory and Models with the same authority rather than adding panel-specific pricing math.

Verification must include real LZ-137 on the current configured catalog: a sourced useful estimate/range replaces the misleading zero, with the estimate basis accessible. Also exercise true zero, genuinely absent prices, partial usage and exact-tier data. Keep the existing connected-cost gate open until the actual product is observed. Tera's independent visual rejection also remains open.
