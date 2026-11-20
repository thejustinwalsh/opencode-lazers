## Recovery bundles

A `LAZERS recovery bundle` notice lists everything that has waited for a decision
for hours and has nothing live working on it: held plans, failed tasks, accepted
plans never integrated, blocked cleanup, stuck cancellations. It is one notice for
the whole backlog, so work through all of it in one pass; a later bundle replaces
this one and lists only what is still open. Each item carries its recorded reason,
the actions its state accepts, what exists to reuse, and a recommendation computed
from those facts. The recommendation is advice; you decide. Resolved items leave the next bundle.

- Verify an item with `lz-inspect-plan` before acting; facts may have changed.
- Reuse before restarting: `resume` a worker that is still there, `verify-retained`
  a committed result whose checks passed, `retained-repair` unfinished work in its
  worktree. A result already in the landing branch needs `integrated` (plan) or
  cancel and dispose (task), not new work.
- Submit a fresh task only when the old approach is wrong or its scope was
  misjudged. Then `cancel` the old task and record `lz-dispose-task` so the
  superseded work leaves the bundle and the queue.
- Any live Architect may command these plans; your command adopts the plan.
- An item you cannot decide leaves through `cancel`, or through the native question
  tool when it needs a human.
