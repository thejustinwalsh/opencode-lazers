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
coordinates. Runtime transition `SCOPE_AMENDED` version 25 at Unix milliseconds
1793976008645 durably added the five contract/producer/test paths, preserving
the immutable task specification and original attempt. Explicit null coordinates
remain unknown; paging and inspection cannot override global chart metadata.

LZ-158 delivered clean `03331c85`. Its runtime panel check passed in 9,264 ms
and quality check in 3,915 ms. Architect woke and requested independent review
without a new driver prompt. Root combined this delivery with the reviewed
pricing fixes and current main as source candidate `d301bc83`:

- Formatting, lint, typecheck (386 files), diff check, and GUI build passed.
- `bun test src/models test/models-decision src/trajectory/accounting.test.ts
  test/models-panel test/models-chart test/observation-panels/root.test.ts`:
  220 passed, 3,296 assertions, 13.59 seconds.
- Log: `/private/tmp/lz-models-full-combined-verification.log`.

The actual Desktop trajectory reports one original Luna Max attempt, 331 tool
calls, 829,789 uncached input tokens, 42,702,208 cache-read tokens, 63,314 output
tokens and 109,745 reasoning tokens. These are the displayed categories, not
an asserted non-overlapping billable-token total. The panel check ends 152:05
after attempt start; that elapsed interval includes interruption and is not
active coding time. Attempt end is not inferred. API-equivalent cost remains
unavailable in that view. Root corrections and reviewer/driver overhead are
additional work, not included in those worker-only figures.

The delivered task is visible in Desktop through Tasks → All → search LZ-158 →
Open trajectory. Both models/quality check receipts appear twice in the timeline;
the duplicate-projection finding is retained for existing trajectory follow-up.

## Integration and live verification

Native e502 review of `03331c85` found no material source defects and passed
81 focused tests. It noted a low-priority missing late-first-page reconnect test;
generation guards appeared sound by inspection. Its attempted worker-progress
report was rejected because the general reviewer was not an assigned implementor;
the final review still returned normally. This is a review-reporting usability
finding, not failed implementation verification.

With all native model sessions confirmed idle, Root fast-forwarded main to
`d1b0c5f` and rebuilt the canonical GUI successfully. Desktop settings activation
was delayed; short read-only samples were captured at
`/private/tmp/lz-models-activation-renderer.sample.txt` and
`/private/tmp/lz-models-activation-service.sample.txt`. They do not establish the
cause. The supported native Restart changed Desktop PID 78646 → 69562 and renderer
78667 → 69585 while service PID 71027 remained. Native Extensions → Plugins showed
LAZERS enabled; Reload was exercised. No inference flags were disabled.

Actual Compare observations:

- The chart renders real Kimi/Qwen market observations and separately marked
  OpenRouter subtotals; Luna has a reference subtotal range.
- Selecting `openai/gpt-6-luna · max` shows 112 accepted tasks and a matching
  row/inspector subtotal range of `$0.353992451071–$0.674016373125` per accepted
  task, with the remainder explicitly unknown.
- A manual Refresh advanced source retrieval from 10:24:13 to 10:27:46 local time
  on November 6, retained the selected Luna route, and produced no displayed
  snapshot-disagreement error. Disclosure identifies exact OpenRouter record
  `openai/gpt-6-luna`, snapshot `56d2686a-b792-4c9e-a145-e86b9d34e7e2`, generation
  159, current/configured source. All positive usage categories have complete
  rate coverage; partial attribution/retry history remains explicit (149 of 151
  related sessions matched, two unknown routes). This is not complete-cost proof.

**Visual acceptance fails.** Actual captures
`/private/tmp/lz-models-live-narrow-first.png` and
`/private/tmp/lz-models-live-wide-first.png` show the Accepted header breaking
across lines, paragraph-height rows, truncated provider-ID chart labels, and
multiple verbose pricing cards burying the primary estimate. Root sent both
captures plus the approved reference to Architect for native Tera High review
and small Luna Max corrections. Code checks do not close this visual gap.

Assignment writes, theme/font changes, final visual acceptance, and native plan
integration/cleanup remain open. The broader roadmap remains active.

Root's clean combined review checkout was removed through native
`worktree.remove(force:false)` after its commits landed on main; physical absence
was confirmed. Its named branch retains the candidate. Native worker worktrees
remain preserved pending their plan's acceptance/integration/cleanup flow.
