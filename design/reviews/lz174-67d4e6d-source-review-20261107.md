# LZ-174 corrected candidate67d4e6d — Root review

## P1: full worktree content fingerprinting reintroduced

Do not integrate this candidate unchanged. `retainedRepairWorkspaceObservation`
in `src/runner/runtime.ts` synchronously runs Git HEAD/status/binary-diff/untracked
enumeration, reads every untracked file with `readFileSync`, base64-encodes each
file, then fingerprints the complete object. Admission and later revalidation
repeat this observation. `retainedRepairRecoveryCurrent` also invokes it on the
command path. The helper has no file-size or total-data boundary; an ordinary
large untracked fixture can produce substantial IO/allocation and block the
shared service event loop during recovery.

This is a source finding in the uninstalled candidate, **not an attribution of
current measured CPU**. No production scan or large-file probe was run. It is
also not a claim that task schema validation, exact task/session/attempt binding,
model routing, native controls or final transactional task checks are invalid.

The user explicitly rejected repository/file content fingerprinting as evidence
and directed models to handle ordinary drift using code/tests/live behavior.
Calling this a recovery observation does not justify reinstating an exhaustive
content-fingerprint admission gate. Remove this new content scanning/gate and
its scan-specific expectations. Reuse the existing native ownership, original
attempt/session/workspace, authorized input and artifact/source-preservation
flows. Preserve useful dirty work and prior history; leave routine implementation
choices to the worker. Do not replace the scan with another full-tree scan or
an arbitrary file-size limit.

## Correction retained

The67d4e6d incremental patch re-reads current task identity, admitted revision,
project/directory and disposition inside the final reservation transaction. Its
ten focused recovery tests passed. Original worker verification also reports
395targeted tests and582runner tests plus quality/build passing. Those are
meaningful checks of covered behavior; they do not make the exhaustive scan
acceptable. Keep that final-admission correction while removing the fingerprint
gate. Use the same original LZ-174 worker/attempt/tree for substantive repair.

Root created a native review worktree at
`/private/tmp/lz174-canonical-integration-20261107`, never merged the candidate,
then removed this clean/unused checkout with native worktree.remove(force:false).
Readback confirmed exists:false. Do not reuse that deleted path. Every original
worker checkout/artifact remains. No production state was rewritten and no worker
tree was changed by this review.

The stored174acceptance requires dirty worktree content and original identity,
usage and receipts to survive recovery. It does not request content hashing or
a full-tree stability proof. The scan was an implementation addition, not a
requirement to preserve in the task. Architect received the exact finding via
native Desktop Steer and explicitly declined integration pending correction.

## Corrected retained candidate

Root corrected the original inactive checkout and committed
`5e1d9ed6756bcc3ff73911c7325b7770498e564d`, descending from67d4e6d.
The full-tree content-reading helper, observation field and all its recovery
admission comparisons are removed. Native ownership/input/control, workspace
identity, artifact ancestry and final task transaction checks remain.

A regression changes useful dirty progress between native revalidation reads.
The old candidate fails with its content-stability rejection; the correction
recovers the same attempt while preserving new content, identity and usage.
13 focused recovery tests/296 assertions passed, as did automatic formatting,
lint and strict typecheck. The broader five-file run had395 passes and one
existing afterPlans timeout at5089.97ms; its unchanged isolated rerun passed
at3251.57ms/40 assertions. No test deadline or assertion was weakened.

The original retained checkout is clean at5e1d9ed. Architect received the exact
candidate, test qualification and source-review request through Desktop. This
does not claim canonical integration, native174 acceptance, original172 recovery
or live qualification. Original attempt/history and recorded6622ebf artifact were
not rewritten. Current canonical Architect tasking guidance must survive merging
the older174 branch.

## Direct correction from a combined review hold

Observed native Models plan09cb85ba reconcile73 immediately return to blocked74
for its existing `root-live-corrected-models:human` wait; the following retained
repair rejected the stale version. The accepted task still needed source changes.
Root extended the existing retained-repair preflight, atomic validation and plan
update to allow blocked unintegrated plans. All existing exact accepted-task,
attempt, owner, route, native input, workspace, integration and dependency checks
remain. This avoids an intermediate reconcile race; it does not accept a candidate
or waive the outstanding product review.

The regression uses an actual accepted isolated task whose combined product
review is missing. Direct repair executes on the same session/attempt/workspace;
after revised task checks pass, combined review remains blocked. The new test
first exposed the additional atomic SQL restriction, then passed after all three
admission sites were aligned. Final suite:17 passed,0 failed,232 assertions;
`bun run verify` passed with automatic formatting/lint and strict checking.
The Architect also succeeded in resuming172 through a tightly sequenced existing
control call before this fix's direct blocked-plan path was observed natively.
Do not claim that workaround as live verification of the new direct path.
