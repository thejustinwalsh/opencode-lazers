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

## Source integration

Root merged29e291a +be50616 with ancestry as846e4e5. Three conflicts were resolved
while preserving main's quarantine, progressive journal and review-input support.
The integration preview exposed a main performance shortcut bypassing the new
failed-input path; it now retains the shortcut for unbound observations and takes
the detailed path for an exact completed failed input. Luna's final source review
also found a workspace/baseline override: terminal continuation now preserves the
retained assignment, rejecting changed selections while accepting unchanged ones
without rewriting the base. Four regression cases cover those selections.

Final canonical runtime/tools/continuation checks:256 pass,0 fail,3932 assertions
(96.89s). Lint and typecheck pass. Native qualification on original129/132 was
requested through Desktop; task/plan acceptance and current completion-observer
repair remain outstanding. Root's merge corrections are driver assistance, not
work performed by the original implementor.

## Native heartbeat correction

Actual129/132 resume was rejected: later generic holds had erased the structured
failed observation. Root initially suspected mixed loaded runtimes; that remains
unproven. Source inspection found a concrete integration error instead: native
metadata heartbeats omit `turn`, supplying it only for `messages:true`, whereas
the fixture returned it for both reads. The merged fast path depended on that
absent detail and bypassed the failed-input observation.

A native-shaped regression first failed with0 detail reads instead of1. The
correction takes one detailed read for a fresh failure and caches its hold only
while the same assignment, native idle timestamp and background observation stay
unchanged. It preserves the structured hold and freshly validates every explicit
resume. Changed timestamps force another read. This is timestamp-based observed
session state, not file hashing or a new evidence gate. All46 related tests/
574 assertions, lint/types pass. Native continuation still needs a successful
reprobe; the prior256-test pass preceded this additional adapter correction.

## Actual failed-worker continuation observed

At1793861829381 both current native holds included their exact input and native
idle timestamp, unchanged since1793861676007/6212 across later heartbeats.
No global reload was performed. Supported resume succeeded at1793861931679 for
129 (planversion35) and1793861931661 for132 (version22). Each DB attempt remains
the single original attempt, session and worktree; only the journaled assigned
input advanced. Native readback at1793861964337/4368 confirms both OpenAI Luna Max.

Actual continuation inputs are129 msg_3bddb1faedae407f9df4f5032cb59826 and132
msg_f23a6ddb3e9746529e30ee31a6f39957. Native active inventory included both at
1793861947607 and1793862114249. LZ132 patched advice.ts and instructions files at 1793862055075. LZ129 resumed tools but spent120s searching the home directory for
a review note absent from its old worktree; Root gave Architect the canonical
absolute path for a same-worker steer. Delivery/consumption of that path still
needs observation. This is real failed-outcome continuation, not proof of the
separate host-restart interrupted path, final worker acceptance or cleanup.
