# Models growing-history repair review

Candidate: `c8530aa0612403e4eb7de9d136183b55660a7b22` (LZ-153).

The original Luna Max worker is inactive/succeeded and clean. Root combined the candidate with the reviewed compact Tasks correction and clean-checkout menu test fix in the existing native review worktree `/private/tmp/lz147-compact-review`.

Independent combined check: **183 tests passed, 2,152 assertions, 21 files**, 9.69 seconds. Command: `bun test src/models test/models-decision src/trajectory/accounting.test.ts`. Worker also reports formatting, lint, types, diff and GUI build passed.

A read-only capture using this candidate against the real LAZERS project DB succeeded at Unix milliseconds 1793939489670: revision 590657, 155 tasks, 16,315 progress facts, no incompleteness notes, 5,273.65 ms. This proves the old 15,000-fact refusal is removed for current project data; it is not a claim that the complete native Models producer or UI has been qualified. The read remains synchronous and its 5.3-second duration is a follow-up responsiveness concern, not a reason to restore an arbitrary data ceiling.

An independent fixture read retained 26 route observations, including an earlier conflicting model alongside later observations, matching baseline behavior. During implementation the worker briefly introduced a 25-observation SQL limit, then removed it before commit. Root did not send a premature repair request for that intermediate change.

Pending: corrected 152 UI source, combined quality/build, canonical integration/activation at a completed-worker boundary, actual native Models reads and screenshot review. Retain source history and native verification state separately.

Combined Tasks + Models review batch `231805d29313ced9b3e73607a78cdacadb302d2d` subsequently passed the full plugin suite: **1,364 tests, 15,208 assertions, 154 files**, 250.53 seconds. Formatting, lint, types, diff checks and GUI build/bundle evaluation pass. Retained logs are in `.agents/docs/evidence/dogfood-20261106/models-tasks-batch-tests.log` and `models-tasks-batch-build.log`. Canonical activation and native visual/producer acceptance remain pending the active LZ-138 worker's completed boundary.
