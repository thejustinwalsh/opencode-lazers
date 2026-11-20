# 81b1d6ba — retention-purge

## Findings

### 81b1d6ba-1 — blocker / confirmed

- **Where:** `src/retention/retention.ts:584-604`.
- **What:** Eligibility and deletion specs are captured once outside batch transactions. Batches reselect row IDs, not whether the plan remains terminal and unreferenced.
- **Failure scenario:** After the first batch yields, another caller retries a cancelled plan's task or creates a pending notice/unfinished dependent plan. The next batch still deletes detail using the original `retiredJSON`, including detail the new reader needs.
- **Evidence:** `classifyPlans` only at 584; `specs` only at 592; transaction at 598 contains only measure/delete. Turns at 611 permit concurrent changes without rechecking protections.
- **Suggested fix / test:** Recompute eligibility/dynamic protection sets inside each batch transaction. Mutate eligibility after the first yield and assert subsequent batches preserve rows.

### 81b1d6ba-2 — blocker / confirmed

- **Where:** `src/retention/worktrees.ts:128-158`; `src/retention/service.ts:221-230`.
- **What:** Removal has no current host-idle check or final eligibility recheck after asynchronous inspection, bypassing ordinary workspace cleanup safety.
- **Failure scenario:** A clean merged retired workspace still has a worker shell/child running, or is reused while probes await. Retention calls native removal although clean status/contained HEAD do not prove nobody uses it.
- **Evidence:** `WorktreeHost` exposes inventory/removal only (9-12). The helper blindly removes an earlier finding; `live` is captured before awaiting inventory/status/containment/size.
- **Suggested fix / test:** Reuse runtime cleanup's live-idle and ownership checks immediately before native non-forced removal. Test running shells, active children, pending input, and reuse during an awaited probe.

### 81b1d6ba-3 — major / confirmed

- **Where:** `src/retention/service.ts:229-236`.
- **What:** Removal failures are swallowed and the purge reports completion; no failure reason is saved despite the comment promising one.
- **Failure scenario:** Native removal refuses a clean registered tree. Settings receives `done: true`, no removed tree, and no explanation; automatic continuation does not retry that run.
- **Evidence:** Empty catch at 232-234 and unconditional true at 236; inspection derives “clean and merged” from git/inventory, not the removal error.
- **Suggested fix / test:** Report the native failure and preserve retryable continuation. Test a rejecting host and assert visible reason and retry semantics.

## Checked and sound

- Tasks, attempts, effects and check/outcome/usage records are absent from bulk-delete specs.
- Removal is native/non-forced; outside-root, unregistered, dirty and unmerged trees are kept.
- Automatic retention defaults off; active attempts prevent starting an automatic slice.

## Not reviewed

- No live database or purge execution; large-database query plans/timing were not measured.
