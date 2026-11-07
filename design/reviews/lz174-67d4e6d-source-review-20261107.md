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
