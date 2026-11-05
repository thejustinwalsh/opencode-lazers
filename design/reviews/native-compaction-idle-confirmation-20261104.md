# Compacted worker completion blocker

Native LZ136 finished commit4a9a8d6 and its combined401-test/quality check, but the
runtime held completion for a missing exact current successful idle marker.
At1793852605945, the native context probe showed46 messages, no user/synthetic
inputs, and the exact successful marker msg_1a9f08e110010fCmsU3YVNIg3x. The durable
idle report bound the original assigned input, zero background and that marker.
Completed compaction had removed the input from model context. The adapter already
resolved current input from retained native history, but its idle-marker validator
still required that input to occur in model context.

Root changed only that context-presence assumption: after completed compaction,
the already resolved retained input can precede the exact latest successful idle.
Current assignment/input/report binding, repeated native inventory reads, marker
identity/outcome, and rejection of a later assistant response remain in force.
No message, attempt, terminal report or lifecycle row was fabricated or rewritten.

Verification:52 tests/334 assertions across native, native-input and native-idle
pass; typechecking, lint and diff checks pass. The new regression covers user and
synthetic retained inputs with matching, foreign-input, stale-marker and later-
response cases. Actual post-reload completion remains unproven at this checkpoint.

Probe: /private/tmp/lazers-current-idle-context-probe-20261104.ts.
Root owns canonical activation at a quiet native boundary; original LZ136 worker
and commit remain unchanged. Architect's final Luna candidate review is separate.
