# Renewal context correction: focused research

Read-only investigation against `9bcf77f`; concurrent documentation commit
`77276d4` did not change the inspected runner source. No implementation, native
inbox cancellation, worker interruption, deployment or profiling was performed.

## Findings for the current Architect

- Original LZ28/LZ30 contracts already cover the relevant lifecycle/outbox
  behavior. Both retained LZ28 trees are clean and their commits are ancestors of
  canonical HEAD; no unmerged compact-context candidate was found. Preserve the
  dirty original LZ129/LZ132 trees and their existing owner.
- `src/runner/store.ts:1144–1284` drains twenty previously unreferenced journal
  records per call into immutable source-reference outbox payloads. Individually
  bounded notices therefore produce unbounded historical inbox growth.
- Different batches can have the **same source revision and disjoint IDs**.
  Latest-revision-only supersession would discard coverage. Mutable results have
  separate result revisions and reset their reference marker. A reference marker
  proves neither admission nor consumption nor review.
- Compact the notification to a source/current-owner pointer and honest available
  and changed coverage. Preserve pending/steering input, changed results and
  actionable worker outcomes. The full journal remains durable.
- Existing `lz-inspect-plan` has no progressive journal view. Its full path loads
  historical activity/outbox and audits; it is not a bounded replacement reader.
  Reuse `src/runner/inspection.ts`, `tools.ts`, source journal tables and renewal-plan
  mappings. A renewal can transfer more than its anchor plan.
- Journal records contain references/status, not original input or tool content.
  Pagination alone is insufficient: selected source content needs permission and
  privacy checks. Reuse the patterns in `src/trajectory/tools.ts` and `privacy.ts`,
  without pretending the worker-scoped trajectory tool reads Architect sources.
- `src/runner/runtime.ts:5622–5674` deliberately excludes source-reference notices
  from supersession. Establish compatible replacement coverage before changing
  that exclusion. Reuse ownership validation, exact native queued-message checks,
  cancellation readback and append-only receipts at `5058–5393`; owner changes
  already reconcile at `5419–5529`.
- Same-owner admitted notices intentionally take the no-op optimization at
  `5404–5418`. Enter an explicit reconciliation path for the retained backlog;
  do not remove the landed no-op optimization or silently rewrite/delete notices.
  Consumed transcript and unexplained absence remain different facts.

## Focused verification changes

1. Replace the historical-ID-draining expectation at
   `src/runner/runtime.test.ts:7399–7446` with compact inbox growth and complete
   progressive retrieval.
2. Preserve both durable mutable-result observations at `8254–8332`, but verify a
   coalesced current notification and discoverable changes.
3. Cover equal-revision disjoint legacy batches, multiple sources, changed owner,
   mixed actionable outcomes and explicit authenticated admitted-backlog recovery.
4. Exercise cancellation/consumption races, lost response, reopen and owner changes
   for source notices, not only ordinary outcomes.
5. Add bounded journal/selected-content retrieval, stale cursor, foreign scope,
   archived source, privacy and read-without-acknowledgement tests.
6. Native proof must measure the **combined handoff and inbox**, demonstrate useful
   continuation and progressive material retrieval while workers continue, and
   preserve unknown usage/cache measurements. Bytes/characters are not tokens.

## Separate retained-worker recovery constraint

At inspection, original129/132 plans are blocked but their attempts remain
`running`; native sessions are inactive after quota failure. Current
`src/runner/runtime.ts:966–973` only permits resume for stopped attempt states
(`exhausted`, `cancelled`, `preparing`, `failed`). A direct resume is therefore not
supported by this source. Use an existing supported owner/runtime recovery flow
and truthful native stop evidence, or expose that focused blocker; do not fabricate
idle lineage, mutate SQL, switch models, replace workers or discard their trees.
