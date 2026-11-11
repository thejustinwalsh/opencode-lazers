# LZ-188 Architect review

Candidate: `a23d58316812b923eba8ee5e363106cb2651e4ab`.
Reviewed independent composition with main: `1c38c703903c136fca2dc6cfa8370542c981cb73`.

## Review result

Approved as behavior-preserving net simplification. Reviewed the entire diff in
`src/models/server.ts`, `src/models/dispatch-resolution.ts`, and the scoped audit
write-up. No tests, schemas, configuration, public exports, or GUI source changed.

- The settings-store factory preserves the same Effect adapter, cancellation
  signal and project key in both the task-valuation provider and Models server.
- The price-index helper preserves native catalog eligibility, ordered source
  policy, whole-source selection, observed routes, provenance and freshness.
  The source-array copy is shallow at the read-adapter boundary; pricing and
  valuation contracts do not change. Inspected `buildCurrentPriceIndex`,
  provider construction in `src/index.ts`, and registered decision readers.
- All four decision RPCs retain schema parsing, project-scope rejection, native
  session/permission revalidation, cancellation checks and output validation.
  The helper adds no storage access or inference authorization. Existing tests
  exercise the registered overview/rows/configurations/inspect surface, denied
  and foreign reads, aborts, store closure and snapshot/price consistency.
- Mapping conversion still validates input before deriving task/project/shared
  source, then parses the same discriminated output. Inspected its runtime
  dispatch caller and tests for all three provenances, explicit override,
  configured fallback, foreign input rejection and detached deterministic output.
  No mapping write, precedence or persisted route identity changed.

The before/after durable Fallow runs are
`90d35b05-57c7-41fa-a3ad-4ded530a8d36` and
`cc6dea81-ce98-4449-8dfd-e6dbffad1dab`, both completed without analysis errors.
Reviewed grouped baseline clone findings 29/51/87 and family23 with their linked
fixed dispositions. Their shared cause is duplicated server authorization and
price-source setup, addressed coherently by the helpers. Remaining complexity
and public dynamic contracts are intentionally retained, not hidden by scores.

## Observed checks and product behavior

Runtime task verification completed successfully: formatter/linter auto-fixes,
typechecking, 252 behavior tests / 3,061 assertions across 26 files, and GUI build
with bundle evaluation. Its process cleanup receipts are settled. Existing
upstream bundler warnings are non-fatal; no new build policy is introduced.

On the independently composed source, Architect ran `bun run verify`,
`bun test src/models src/runner/catalog.test.ts src/trajectory/accounting.test.ts`
(235 pass, 0 fail, 2,617 assertions, 23 files), and `git diff --check`; all passed.
These include the registered production RPC behavior and exact dispatch mapping
paths, not merely helper tests or an analyzer result. GUI rendering/source is
unchanged, so retained task rendering/build receipts suffice without a new
networked preview or a connected visual acceptance claim.

## Integration boundary

This independently useful audit consumes no uncommitted steering or cleanup
repair source. Preserve their original workers and normal write reservations.
Use the same observed local source-watch activation boundary documented for
LZ-187; no explicit server-wide reload/restart or canonical GUI rebuild.
Only record review evidence against the runtime's exact current candidate, then
reconcile normally. Native non-forced cleanup must establish its own settlement;
review approval is not idle proof.

## Integration and cleanup observed

The exact accepted candidate was landed on main through `d9bdf359` and runtime
integration recorded against that landing HEAD. The plan reached integrated at
version16. Its original worker checkout has a completed removal receipt with
`native: true` and `cacheRetirement: evicted`. The clean, merged Architect review
checkout was removed natively with `force: false`. The original LZ-154 worker
continued on the same attempt after landing. Both Root-owned review resources
remained in native inventory.
