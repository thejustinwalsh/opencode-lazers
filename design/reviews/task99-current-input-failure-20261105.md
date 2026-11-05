# LZ99 draft: current failure swallowed after continuation

Root reproduced a defect in the original LZ99 worker's uncommitted candidate,
using its existing runtime fixture in a disposable copy of runtime.test.ts.
No production data or worker files were changed.

1. Hold the original interrupted attempt with unknown background state.
2. Explicitly resume that exact attempt and tick to deliver its new assigned input.
3. Observe the same worker as inactive, failed and completed for the **new** input,
   retaining the previous unknown-background value.
4. Tick again. The plan incorrectly remains running; the expected new failure
   observation and blocked state are missing.

Command: `bun test /private/tmp/lazers-lz99-current-failure-review.test.ts -t 'root review:'`.
Observed: 0 pass, 1 fail, 14 assertions; expected blocked, received running.
The private reproducer contains a copy of the current fixture and the added test.

`isPriorContinuationBackground` compares the old unknown-background value and
prior input history without considering the current turn input. Its early return
in worker reconciliation can suppress a genuinely new current-input failure.
Delayed old-input observations still need to be ignored; current-input failures
and pending approvals must remain visible. This is a correction within LZ99,
not a new task or acceptance condition.

Root delivered the reproducer to the existing Sol High Architect through Desktop
and native Steer. Repair, permanent regression coverage and reprobe remain pending.
Passing the earlier 166-test runtime suite and 341-test runner suite did not cover
this continuation sequence. Real retained quota-worker recovery is still unproven.

The original worker subsequently changed reconciliation in its retained tree.
Root reran the same disposable regression against that updated runtime: 1 pass,
0 fail, 15 assertions. The draft checks permissions before stale-input suppression
and no longer returns early on background equality before processing a current
terminal outcome. Permanent worker regression coverage, final review/integration
and native retained-worker qualification remain pending; no production lifecycle
state was changed by this fixture test.
