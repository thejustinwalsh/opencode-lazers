# Accounting route ownership review

2026-11-02 · Root source review of LZ-78 artifact `05d2355`.

## Reproduced finding

`projectTaskEffortBasis` groups every observed step by session, then compares the
entire session group to each attempt's requested/frozen route. Exact progress
`attemptID` ownership is discarded when constructing route observations.

Two correctly routed attempts sharing a session therefore get false mismatches:

| Attempt   | Its actual step | Requested/observed model | Incorrect extra assessment   |
| --------- | --------------- | ------------------------ | ---------------------------- |
| attempt-a | message-a       | a / a                    | message-b, b compared with a |
| attempt-b | message-b       | b / b                    | message-a, a compared with b |

The source fixture ran against the actual candidate module and returned four
assessments and two mismatches; expected ownership yields two assessments and no
mismatches. Both retained step facts supply their exact attempt IDs. No native
state or DB rows were changed; this is a regression fixture, not a model benchmark
or a native acceptance claim. Temporary runnable reproduction:
`/private/tmp/lazers-accounting-route-review.ts`.

Source: `src/trajectory/accounting.ts`, `parseObservedProgressRoutes` and
`routeAssessments` around lines 550–760. Preserve exact step/attempt association
when known. A current session route is not a historical per-attempt observation;
keep context-only observations honest when they cannot be assigned. Preserve
session-deduplicated usage and mixed-route coverage.

## Additional review concern

The new unpaged effort payload repeats per-session category details in both
`usage.sessions` and `usage.categories[].bySession`, and emits step observations,
per-attempt assessments and mismatch copies. Shared sessions can multiply route
records across attempts. Check response size and production read behavior while
repairing the ownership bug; do not add a rejecting token cap. Prefer a concise
summary with relevant drilldown. The two-attempt/two-step regression fixture returned22,381bytes for this effort
basis alone. This is a measured fixture payload size, not a native freeze or
latency benchmark; do not generalize it into a measured production regression.

Full artifact review is unfinished. Tests claimed by the worker do not resolve
this reproduced ownership defect.

## Prepared focused correction

[Correction artifact](accounting-route-correction.json) contains an exact unified
diff against `05d2355` in its JSON `patch` field. It preserves the retained
attempt ID on route observations and compares a shared-session step only with
its unique known owner. Ambiguous context/current-session observations remain
visible without generating historical attempt comparisons. Single-attempt
behavior and session-deduplicated usage are retained.

Two added regressions failed on the returned source and pass with the correction.
Compatibility:21 accounting/read/store tests,181 assertions; strict typecheck and
lint of both changed files; formatting clear with pinned Bun1.4.4-canary.1. The
existing pagination/read-only/reopen/privacy tests passed. No runtime task/DB state
or returned worker artifact was changed. Native application and review still need
the Architect; Desktop was locked during preparation.
