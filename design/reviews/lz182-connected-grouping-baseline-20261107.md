# Tasks grouping under live activity

Root opened the current registered Tasks panel in actual Desktop with all three original workers active. This is the existing GUI, not LZ-182's unmerged candidate. State was Project / All. The filter menu already offers Open, Queued, Running, Blocked/waiting, Completed, Failed/exhausted, Cancelled and All; no state change was made.

The panel first reported unavailable topology and then explicitly **“Execution topology changed during the task read. Showing ungrouped tasks.”** It did show all three current workers as active after loading. Thus task rows/current activity are present while the required grouping falls away during real work. [Desktop baseline](artifacts/lz182-desktop/before.png).

Source review of the active LZ-182 checkout confirms `src/tasks/panel-state.ts` still discards topology when `observed.boundary.repositoryVersion !== first.snapshot` (around line345). Its new scheduling reader correctly pins its own pages and does not require equality with the task page; that is separate and is not the reported defect. `buildExecutionList` still returns ungrouped rows when topology is missing, even with scheduling data present.

LZ-182's ordering/grouping acceptance should include real ongoing unrelated progress writes. Reconcile the grouping/task/scheduling read composition so ordinary activity does not permanently remove coherent plan/dependency grouping, while preserving scope, visible-task associations, pagination and materially changed relationships. Reuse existing authorities; do not make an unrelated task-row watermark or ongoing progress write an automatic reason to lose all grouping. Implementation choice belongs to the current worker. No new task or new polling/producer is needed.

This observation does not prove the unmerged LZ-182 UI has failed live. It identifies an inherited source path and supplies the actual concurrent workload to exercise during its connected walkthrough. Root preserved task selection and did not start, stop or alter any task.
