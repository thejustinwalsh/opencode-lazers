# Verification gate audit

The reported Radar quality failure was exit 127: `/bin/sh: bun: command not found`.
The previous generic reason combined command failures with input changes and
concealed that actionable cause. This repair changes the existing verification
flow; it introduces no replacement workflow or additional task gate.

## Removed

- Retained-check file-content hashing and `git hash-object` preconditions.
- Clean-working-tree admission for retained verification and repair.
- Automatic expiry of passes from environment, input, procedure or definition
  metadata changes. Differences remain available for Architect review.
- The `unchanged` flag as a condition for passing commands, trajectory results,
  maintenance receipt validation or acceptance. Old receipts remain readable.
- Bun-only command grammar, package-script preflight rejection and blanket
  localhost/service URL restrictions on configured checks.
- Source edits, documentation writes, rebuild timestamps or bundle size changes
  locking the owned Desktop verification instance out of further interaction.

## Resulting behavior

A command passes when it exits zero without timing out. Receipts retain its
command, output, exit status, Unix millisecond timestamps and observed source.
Architect reviews the feature and decides whether later changes need another
check. Live probe results retain their actual verdict and recorded context.
Cleanup remains separate from the product result.

Check processes discover installed Bun even when the Desktop service PATH omits
it, including when a test uses a private HOME. Missing executables and timeouts
hold the same attempt with a specific reason. Reconciliation can rerun a failed
check while preserving earlier receipts. Successful automatic fixes are captured
in the delivered commit without dispatching another implementation attempt.

The native task/attempt association, authorized operation, project boundaries,
concurrent ownership and safe resource deletion checks remain. These identify
which work/process the operation affects; they do not establish product quality.
`lz-verify-task` self-review, advisory System One and structural validation remain.
Idempotency keys and resource-ownership identifiers are not source-file evidence.

## Verification

Regression coverage exercises checks that edit tracked files, auto-fix capture in
the same attempt, missing Bun in the service PATH, preserved uncommitted worker
work, metadata drift, retained passing receipts, independent cleanup, live probe
ownership and continued access to an edited owned Desktop candidate.

- `bun run verify` passes: automatic formatting, lint fixes and typechecking.
- The exact previously failing command, `bun run verify && git diff --check &&
bun run build:gui`, passes through `runCheck` with PATH limited to standard
  system directories: exit 0, no timeout, 4,123 ms. GUI build retains existing
  ONNX `import.meta` warnings.
- Runner/probe/resource/progress and Desktop-boundary sweep: 820 passed; three
  timed out, causing three teardown errors (823 tests, 41 files, 342.52 s).
  No assertion failure occurred. The two affected runtime cases pass separately
  in 2,945/2,678 ms with their existing default timeout. The phase-pair adoption
  test is now two independent cases; both pass in 6,539/4,625 ms with the existing
  10-second per-case timeout. No product timeout was raised.
- Earlier focused runner/progress follow-up: 387 passed, zero failures.
- Owned Desktop/maintenance/trajectory surface checks: 65 passed, zero failures.

Ignored `.cache/driver/verification-audit-*.log` files retain the raw test output;
`verification-path-repro.json` retains the actual command receipt. These are local
run artifacts, not requirements for another agent to manufacture.

Native activation remains unconfirmed. Architect received repair coordination
and asked to preserve current work while Root handles admission. Desktop shows
the selected answer, but subsequent input/submission is unreliable and its
screenshot disagrees with its accessibility state. Do not claim the running
service has these changes until supported reload and actual reconciliation are
observed. No production SQL was used; no work or failure history was discarded.
