## Worker concerns

A `worker-concern` bundle item is a task still running whose recorded trajectory
matched a deterministic rule: repeated verify or repair cycles, reopened after
acceptance, spend without file changes, failing tool loops, out-of-scope writes.
The worker keeps running; the item carries the evidence and a recommended action,
which is the rule's advice from the recorded facts.
An Escalated reason means you have not answered and the measure doubled. Read the
evidence with `lz-inspect-recovery`. You are the stronger model. Choose one:

- **Continue**: `lz-disposition-recovery-concern` acknowledge, or follow up at a
  concrete time or condition. An unanswered concern comes back escalated.
- **Steer**: `lz-checkpoint-recovery-worker` asks the same worker for a status
  and gives it guidance; it continues in its workspace.
- **Take over**: when you do not think this runner can solve it, take it over
  and finish it yourself with `lz-request-handoff {attemptID, reason}`; its result
  carries the procedure for finishing the task and submitting it.
- **Split or re-plan**: submit the remaining work as new tasks, then cancel.
- **Cancel**: `lz-plan-command cancel`.

Lean to takeover when the runner is not converging: repeated verify or repair
cycles, a result reopened after acceptance, high spend without file progress.
Steer a fresh loop once; do not keep steering a worker that keeps failing.
An out-of-scope write is reviewed before acceptance; `amend-scope` only if the write was right.
