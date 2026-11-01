# Live Flow inspector follow-up

Root observed that switching from b50 to live progress plan `b9e55d09` updated
the Flow graph but left its state inspector showing prior task `efd8459f` and
Current No. Clicking the running state did not refresh that captured identity.
[Original native mismatch](flow-inspector-before.png).

The state `Show` remained truthy while its body had captured `flowNode()` and
`snapshot()` once. The inspector now retains their accessors instead: each
rendered field reads the current task/snapshot and selected state. Existing
Current/Initial/machine/reason labels and unsupported/mismatched/unavailable
semantics remain unchanged; no scheduler or panel redesign is included.

The regression creates one inspector, then switches from accepted projection
`efd8459f` to running progress `01d89f85` without recreating it. Task and Current
update together; selected-state, machine-version and unavailable-input changes
also update the same accessor. This is a source projection test, not a Desktop
observation of the repair.

`bun test src/radar test/radar`: **15 passed, 96 assertions**. Whole-repository
formatter/lint/types and the production GUI rebuild pass, with the existing
Vite/ONNX build warnings unchanged. Root will retest the rebuilt native panel.
Original progress and dependent lifecycle work remain untouched; no new task or
worker was created for this observed integration bug.

Root's native retest on rebuilt `5a2b39c` switched from live progress to b50
(the inspector showed accepted projection `efd8459f`), then back to progress
without closing/remounting the panel. The inspector updated to running task
`01d89f85-5eeb-4797-a0a8-18b2521e1cfa`, Current **Yes**, matching Flow's current
state. The original stale task/current mismatch did not recur.
[Repaired native view](flow-inspector-after.png),
[accessibility result](flow-inspector-after.txt).
Full combined checks subsequently passed **355 tests / 3,323 assertions**, plus
formatter, lint and strict types. Radar is left on the actual running progress
plan. The earlier freeze remains a separate unresolved issue.
