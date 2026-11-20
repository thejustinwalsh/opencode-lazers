# 93bb4046 — recovery-bundle

## Findings

### 93bb4046-1 — major / confirmed

- **Where:** `src/runner/recovery-bundle.ts:862,907-910` (later `e23cb2c5` adds a notice marker, not pagination).
- **What:** Recovery delivery lists only 60 items, with no continuation or omitted plan IDs. Its fallback tells the Architect to list plans using `lz-inspect-plan`, which requires a known plan ID rather than enumerating the backlog.
- **Failure scenario:** 61 held plans need decisions. The last one is counted but not identified; the bundle marks all 61 keys covered for six hours. Architect cannot retrieve item 61 from this notice and may believe the listed backlog is the actionable set.
- **Evidence:** Rendering slices `bundle.items`; reconciliation persists all keys as covered (`src/runner/recovery-bundle.ts:758-759,834`). The raw saved payload contains the item, but no bundle paging/retrieval surface is supplied by this unit.
- **Suggested fix / test:** Page recovery items with a real continuation/retrieval call, or deliver all item identities with paged detail. Test 61+ distinct plans and prove every omitted item is reachable before resolving earlier items.

## Checked and sound

- Bundle generation insertion is fenced and rechecks generation in its transaction.
- Re-observation/delivery churn does not refresh stale-work age.
- Contact pause blocks new bundle delivery; no separate workflow state is introduced.
- Unknown git containment/check evidence remains unknown rather than becoming success.

## Not reviewed

- No live backlog or native session-routing walkthrough.
- Runtime tests were read, not run; worktree/git fixtures exceed the write scope.
