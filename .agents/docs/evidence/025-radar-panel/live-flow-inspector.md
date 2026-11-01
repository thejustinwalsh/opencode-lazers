# Live Flow inspector follow-up

Root observed that switching from b50 to live progress plan `b9e55d09` updated
the Flow graph but left its state inspector showing prior task `efd8459f` and
Current No. Clicking the running state did not refresh that captured identity.
Root's original screenshot is
`/private/tmp/lazers-native-current/radar-active-progress-selected.png`.

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
