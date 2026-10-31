# Explicit shared retry baseline

## Spike record

- **Question:** Does a corrected shared retry start from the exact baseline the
  owner selected, including after the runtime is reopened before dispatch?
- **Increment:** Make a retry's explicit shared baseline authoritative for only
  the next attempt while preserving ordinary continuation and attempt history.
- **Scope:** Runner retry admission/dispatch, real-Git regressions, and the
  source-backed recovery evidence below. No model-quality comparison, new
  approval/resource/source-hash gate, scheduler redesign, or active-freeze work.
- **Acceptance:** An explicit baseline wins over both an older failed artifact
  and an accepted predecessor artifact; a retry without a new baseline keeps
  continuing from its prior artifact. Existing artifact-bound verification and
  measured usage remain intact.

## Corrected flow

For a shared retry, command admission records `selectedBaseline` in the durable
`RETRY_REQUESTED` transition (`null` when the owner did not select a new
baseline). `WORKSPACE_SELECTED` also records the selected source and whether it
was explicit. Dispatch applies a non-null selection only when its `attemptID`
still identifies the most recent prior attempt for that task. This makes the
choice survive runtime reopen without letting a stale retry selection affect a
later continuation. The new attempt's `base_commit` and policy `source` record
the actual source used; historical attempts are not rewritten.

Without a newly selected baseline, base selection retains its previous order:
the task's latest artifact, an accepted predecessor artifact, then the shared
checkout or plan baseline. Verification stays attempt-scoped and binds each
receipt to the new artifact. `commitArtifact` computes scope changes from that
attempt's `base_commit`, so review changes already present in an explicit
baseline are not misclassified as worker edits.

## Regression evidence

`src/runner/runtime.test.ts` creates separate real Git commits for the original
plan base, an accepted predecessor artifact, a failed worker artifact, and a
reviewer correction. It admits the retry from the correction, stops the old
runtime, expires its test lease, and dispatches with a new runtime. The test
asserts the exact attempt source, workspace, reviewer-file preservation,
task-scope diff, successful acceptance, prior usage/outcome retention, and
separate failed/successful verification receipts. With the old artifact-first
selection, the new attempt would use the failed artifact and include the
reviewer-only commit in its scope diff.

A companion regression retries without a new baseline and proves continuation
from the failed artifact, preserved prior usage/outcome, and new artifact-bound
task and graph verification. Existing runtime, artifact, process-recovery,
cancellation/resume, dependency, and scope regressions are included in the
focused suite; no new gate was added.

Source references:

- `src/runner/runtime.ts`: shared retry selection and durable retry transition;
  admission is at lines 159-225 and dispatch associates a selected source with
  the attempt it follows at lines 529-541.
- `src/runner/store.ts:291-301`: `latestTransition` reads retry history without
  changing stored attempt provenance.
- `src/runner/artifacts.ts:65-99`: scope comparison and candidate creation use
  the selected attempt base.
- `src/runner/runtime.test.ts:588-703`: explicit-baseline reopen regression;
  lines 705-767 cover continuation/history.

## Recovery observation

The observed trigger and worker-only measurements are transcribed in
[`evidence/020-explicit-retry-baseline/tuning-observation.md`](../evidence/020-explicit-retry-baseline/tuning-observation.md).
They explain recovery friction; they are not a model ranking, quality measure,
or cost-savings claim. Cost remains unknown because no dated API pricing was
applied.

## Verification

Recorded command outcomes are in
[`evidence/020-explicit-retry-baseline/verification.md`](../evidence/020-explicit-retry-baseline/verification.md).
