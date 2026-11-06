# Models pricing review follow-through

## Reviewed changes

LZ-157 delivered `f8c5e2e`; LZ-166 delivered `1c1070b`. Native Luna Max
reviewer `ses_e522ffd49ffeenRSBj8xvTAxMB` identified the mixed-call tier-bound
and exponent-zero defects, then reviewed the correction. The conservative
per-category envelope was sound by inspection. Three remaining findings were
corrected by Root at `5e739d8` in an OpenCode-created isolated review checkout:

- The mixed-call regression now uses a threshold of 99 and a 100-token call,
  respecting the native pricing rule's strict greater-than comparison. The
  exhaustive hypothetical tier-allocation test is named as such.
- Positive usage with no known applicable rates yields no numeric subtotal.
  A published zero rate remains a legitimate priced zero.
- Positive-to-zero underflow when dividing a total, range, or subtotal by the
  accepted-task denominator yields partial pricing with an arithmetic concern,
  rather than a false zero price. Usage and coverage remain available.

## Verification

The isolated tree includes current main `204a64d` and the delivered producer and
correction commits. It preserves the current runtime and GPU fixes; the original
worker commits remain in history.

New regressions failed before the Root correction: an absent-rate subtotal was
zero and an underflowed per-task value was marked exact. After correction:

- `bun test src/models test/models-decision src/trajectory/accounting.test.ts`:
  202 passed, 2,380 assertions, 9.64 seconds.
- After the final subtotal-fixture threshold correction, the focused estimator
  file passed 14 tests and 143 assertions.
- Formatting, lint, typecheck (386 files), and `git diff --check` passed.

Driver-local logs: `/private/tmp/lz-models-review-regressions-before.log`,
`/private/tmp/lz-models-review-final-tests.log`, and
`/private/tmp/lz-models-review-regressions-final.log`.

## Native observations and remaining acceptance

The original LZ-158 UI worker and the pricing reviewer stopped after
`provider.auth: getaddrinfo ENOTFOUND auth.openai.com`. DNS subsequently resolved
for both auth.openai.com and api.openai.com. Through Desktop, Architect resumed
the same worker/attempt and reviewer; native activity confirmed both running.
No provider substitution, replacement worker, or worktree reset was used.

A failing LZ-158 panel test exposed global chart labels changing when another
row page loaded. Root reported the source finding through Desktop; Architect
authorized the same worker to add producer-owned chart labels and token
coordinates. That correction is still in progress and is not covered by the
backend results above.

This record does not establish connected price-data correctness, narrow/wide
visual fidelity, assignment behavior, final combined integration, or cleanup.
Those remain pending actual Desktop observation and Tera High visual review.
