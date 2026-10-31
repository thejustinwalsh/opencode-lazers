# Incoming Trajectory review — selected-plan attribution

Root's read-only report `/private/tmp/lazers-trajectory-projection-review.md`
identifies a P1 in the in-progress `src/trajectory-panel/projection.ts` for task
`f1b1a687-31b7-4edb-a6bc-1865f61e0bdd`, existing attempt
`360ba25c-ae49-4994-9712-b6f050066284`. No returned artifact is claimed yet.

The driver independently reproduced it through the current exported
`buildTimeline`: project snapshot plan A contains task A/check A, and plan B
contains task B/check B; both checks are plan-scoped (`taskID:null`). Selecting
task A returned **check A and unrelated check B**. This is incorrect check/time
attribution, not a visual preference.

The existing worker received native instruction entry
`lazers-trajectory-incoming-review` on session
`ses_2757f95e0fd2467ebd9c8a80ff58bc0e`, without interruption or checkout edits.
The repair belongs to that current task: derive allowed plan IDs from all scoped
snapshot plans containing the selected task, retain the selected task's checks
and only those null-task checks whose plan is associated, and do not assign
unknown legacy plan IDs to every task. Review the returned code and require
regressions for unrelated plans and multiple associated plans; do not infer that
the instruction has already landed just because it was delivered.

The report's old snapshot-shape warning is resolved by `bf5a8b0`/`d3030f5`,
which adds actual snapshot attempts/checks and their strict RPC contract.
Potential future non-null attempt-end handling is not a current-data blocker:
the current reader deliberately leaves attempt ends unknown and keeps recorded
worker-activity ends separate. Unknown token/cost contributions must remain
unknown in the panel, not become zero; that is a consumer review requirement,
not a demonstrated parser defect.

## Native RPC evidence reported by Root

Root successfully exercised actual registered trajectory RPC for running
`f1b1a687` and accepted speech `3af64c61`, receiving real native session context
and five-event pages in **95 ms / 106 ms**, respectively. These are individual
observations, not a performance guarantee or full-history claim. They establish
live rich-RPC delivery for those tasks, not the unreturned panel's visual
acceptance or all legacy native-token comparisons. Actual assembled Desktop
captures and Terra review remain required.
