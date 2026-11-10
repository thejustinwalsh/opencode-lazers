# Combined verification recovery: Architect bootstrap review

## Authorization and boundary

The user authorized activating reviewed recovery source before this plan's
combined acceptance, then using its registered public continuation control.
This does not authorize acceptance overrides, receipt rewriting, worker
replacement, direct production SQL or bypassing prerequisite integration.
The user subsequently confirmed that the overlapping main writer had paused and
handed off the runtime/schema files for composition.

## Source review

Worker candidate `0c665a7f85deb393a305cbbc30f6f5bc8748d848` adds plan-level
`lz-plan-command` resume for interrupted combined verification. Architect read
the runtime, schema, registration and regression diffs. The admission path binds
the current project/owner/control epoch, plan body/version, accepted artifacts,
source generation and exact interrupted payloads/receipts. It requires aborted
checks with explicit settled process evidence, an unchanged retained checkout,
and no unrelated unresolved effects or active verification/adoption.

The new epoch retains the interrupted receipt byte-for-byte and records a fresh
check separately; it neither prompts an accepted worker nor repeats task checks.
The registered-command test covers lost replies, reopen, replay and eventual
acceptance. Refusal tests cover authority, candidate movement, missing/uncertain
process settlement, live activity and unrelated uncertainty, including a hold
introduced during a fresh combined check. Existing task-level continuation
coverage remains in the declared runtime suite. No blocking finding was found
in this source review; this is not independent reviewer approval. A native
review-helper attempt was unavailable because of the subagent depth limit.

## Preserved interruption and checks

LZ-202's original task check passed. Its subsequent combined check was aborted
with exit 137; the disk receipt records a terminated process group and an
incomplete check chain. That result is not a product-test failure or a pass.
Audit and ordinary reconciliation preserved the hold under the old live API.

The first isolated composition on main `9263353` passed `bun run verify`, all
448 declared behavior tests (6,691 assertions), and `git diff --check`.
Main then advanced to `534cdef`, including dispatch pause and cancellation
propagation. The new composition retains that source and the original worker
commit as ancestors. The only textual merge conflict was the public command
description; both pause/cancellation semantics and combined-resume guidance were
retained. On this composition, `bun run verify`, all 456 tests across the six
declared/dispatch-control files (6,777 assertions), and `git diff --check` passed.
Runtime acceptance and native cleanup remain separate.
