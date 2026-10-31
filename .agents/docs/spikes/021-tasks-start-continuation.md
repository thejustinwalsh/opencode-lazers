# Tasks Start and durable Architect continuation

## Spike record

- **Question:** Can a Tasks inspector Start request admit real work without
  duplicating execution, losing work across a restart, or presenting state the
  runtime has not recorded?
- **Increment:** Connect the panel Start action to the task runtime, make
  execution status and history readable, and recover durable Architect ownership
  and notification delivery.
- **Scope:** Task RPC/runtime start and continuation, task reads, the inspector
  layout/state, and focused regressions. No Radar UI, task links, GPU/settings,
  inference, or unrelated backlog work.
- **Acceptance:** Native permission and project/revision checks precede runtime
  execution; duplicate/reconnected starts converge on one plan; active, blocked,
  failed, cancelled, and accepted task state comes from records; full objective
  and criteria remain readable; missing or archived owners continue through one
  linked Architect session; durable native notifications recover without a
  duplicate logical message; admitted work proceeds without another click.

## Runtime and read behavior

The panel's `start` RPC checks the selected live same-project session and invokes
the native `lazers_start_task` permission assertion for the task resource before
calling `TaskRuntime.startTask`. Runtime start validates task/project
provenance, task revision, and a committed starting revision. Its request ID is
derived from the immutable task ID and revision. Only plans bearing that exact
Start identity are automatically resumed from `draft`; ordinary submitted
plans still require their normal runtime admission command. This lets the
scheduler recover an interrupted Start after restart without broadening
admission for other draft plans.

Continuation IDs are persisted before native session creation. A missing native
session reuses its persisted ID; an archived, foreign, or mismatched session is
replaced by a new same-project Architect, linked to a same-directory parent
when one is safe. A lost create response is reconciled by reading the native
session back. Outcome delivery targets the current Architect with a stable
synthetic message ID and native queued delivery, and retries the same logical
message after an uncertain response. Cancelled plans are not reopened by Start.

Task query summaries and detail now expose execution reasons, attempts, and
transition activity from the runner store. A plan-level admission block maps
queued/ready nodes to the recorded blocked reason instead of leaving the
inspector to imply they are still actionable. The inspector shows the Markdown
objective and all acceptance assertions once, with metadata-only controls and
closed Details, Activity, and JSON disclosures. Its split is calculated from
the live header, separator, and root bounds; list and detail panes scroll
independently and the selected percentage remains persisted.

## Regression evidence

Focused regressions cover concurrent and repeated Start requests, permission
denial and invalid actors, stale/foreign tasks, cancelled-task non-revival,
record-backed blocked/accepted state, continuation creation before/after lost
responses, process restart without a manual Start retry, native outbox
recovery, and split geometry with changing header height and multiple moves.
The complete commands and measured results are recorded in the verification
section after the final run.

Source references:

- `src/tasks/rpc.ts`: native actor/permission gate for Start.
- `src/runner/runtime.ts`: stable Start identity, Architect continuation
  recovery, task-start draft recovery, and native outbox delivery.
- `src/runner/store.ts`: durable continuation/outbox state and record-backed
  task execution/activity.
- `src/tasks/read.ts` and `src/tasks/panel.tsx`: status, reason, attempts,
  activity, Start action, and complete inspector content.
- `src/tasks/panel.css` and `src/tasks/panel-layout.ts`: flexible split tracks
  and live geometry.
- `src/runner/runtime.test.ts`, `src/tasks/rpc.test.ts`,
  `src/tasks/panel-state.test.ts`, and `src/tasks/panel-layout.test.ts`:
  focused behavior coverage.

## Native review

Current Desktop behavior and visual fidelity remain unverified. The available
captures at `/private/tmp/lazers-tasks-native-20261031.png` and
`/private/tmp/lazers-tasks-details-native-20261031.png` predate this increment;
they are useful only as the before state. The missing observations and limits
are listed in
[`evidence/021-tasks-start-continuation/native.md`](../evidence/021-tasks-start-continuation/native.md).

## Verification

See
[`evidence/021-tasks-start-continuation/verification.md`](../evidence/021-tasks-start-continuation/verification.md)
for focused tests, GUI build, full tests, and quality-check outcomes.
