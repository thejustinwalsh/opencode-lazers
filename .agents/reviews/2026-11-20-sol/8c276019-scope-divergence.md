# 8c276019 — scope-divergence

## Findings

### 8c276019-1 — minor / confirmed

- **Where:** `src/runner/runtime.ts:11557-11568`.
- **What:** The overlap information sent for a scope decision omits queued tasks in other plans. Only this plan's unfinished nodes and other plans' active attempts are considered.
- **Failure scenario:** Plan A diverges into `src/b.ts`; queued Plan B owns `src/b.ts` but has no attempt yet. A's divergence report says no task scopes it, withholding information the Architect is told to use before amending scope.
- **Evidence:** `scopeOwners` builds IDs from `nodes(plan.id)` and `activeProjectAttempts()` only, despite describing “other unfinished tasks.” `scopedBy` cannot name B without its scope.
- **Suggested fix / test:** Include unfinished queued tasks across project plans in the scope-owner read. Test two plans where only A has an attempt and B reserves the divergent file; assert B is named.

## Checked and sound

- Protected paths win classification; directory/glob edit scope differs from expected-new structure.
- Repair-chain scope review measures the whole task change, not only its last repair delta.
- Scope amendments clear a divergence hold only after covering every divergent path and checking unsettled non-rerunnable effects.
- Automatic check edits that create a new commit return for another verification pass.

## Not reviewed

- No runtime/worktree tests (they write outside permitted paths and invoke fixers).
- Did not exhaustively prove all scope-glob overlap combinations or downstream native filesystem enforcement.
