# Simplify orchestration: the request is the authorization

Owner direction (2026-11-17): LAZERS is local-first. The moment the user types
a request, the Architect is authorized. The scheduler routes to the plan's
Architect, or creates a new one. Tasks are text instructions plus artifacts.
Gating for speculative reasons is bad code. Every remaining hold notifies the
Architect, and the Architect can always push the work forward.

The evidence comes from the driver's gate audit of the live DB on 2026-11-17.

## Dispatch is decoupled from the Architect

When a task enters the system, the scheduler runs it. The Architect never has
to say "run". The Architect is a service that a task calls on demand, for a
question, a review or integration, or a hold that needs judgement:

- If the task's Architect session is live, the task contacts it.
- If the task has no Architect, or its Architect is gone, the scheduler
  creates a new Architect session with the plan context.

The Architect plans and decides. The scheduler executes and routes. Neither
waits on the other except where a task actually needs judgement.

## Rule for every hold

A hold may exist only if:

1. it protects against real, unrecoverable loss;
2. its condition can be observed directly at the time of the check; and
3. it raises to the Architect with an advertised action that unblocks it:
   proceed (with a recorded reason), retry or cancel.

Anything else is deleted.

## Holds that stay (directly observable)

- A prerequisite change is not contained in `main` (change containment).
- A write scope overlaps. This is a warning only; parallel work stays allowed.
- A worktree has uncommitted or unmerged work.
- A process is still running in a worktree. This is checked live: OpenCode
  session `busy`, pending input, permissions or forms, running shells whose
  cwd is in the worktree, and active child sessions.
- A check fails, or a merge conflict is real. The notice includes the failing
  output or the conflicting paths.
- The scheduler lease fence between two processes.
- The effect journal for prompt and worktree creation, which prevents
  duplicates.
- A pause set by the user or the Architect.

## Removed or replaced, in priority order

| #   | Change                                                                                                                                                                                                                                                                      | Unblocks                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Remove `kind: "human"` acceptance evidence. The Architect's integrate decision is the review.                                                                                                                                                                               | 17 plans                                          |
| 2   | Replace the `experimental.idle` report and lineage chain with the direct live idle check above. Unknown means asking the host now, not waiting for a hook.                                                                                                                  | 6 blocked, 2 cleanup-blocked, 13 leaked worktrees |
| 3   | Remove cleanup-recovery authorization and settlement. A worktree is removed when it is clean, its change is contained in `main`, and it is idle.                                                                                                                            | Ends the 4,991-row retry loop                     |
| 4   | Verification effects (`verify`, `graph-verify`, `mechanical-fix`) are re-runnable. A missing receipt means re-run. The rule that `reconcile` refuses while effects are uncertain is deleted.                                                                                | 3 plans                                           |
| 5   | Owner is advisory. A command from any live Architect of the project is accepted and adopts that Architect as owner. Routing goes to the live owner, otherwise to a new Architect with the plan context. `planControlEpoch` and every authorization bound to it are deleted. | All stale-authorization failures                  |
| 6   | Submitting a plan admits it, and the scheduler then runs its tasks with no Architect "run" command. The base-commit and model-route preflight checks stay. Drafts exist only when the Architect explicitly asks for one.                                                    | 6 drafts                                          |
| 7   | Delete continuation fingerprints. `resume` re-runs the combined check on the current candidate.                                                                                                                                                                             |                                                   |
| 8   | Collapse retained verification into a single call that verifies a given commit in a temporary worktree. Delete generations, authorizations, the quarantine ceremony and the extend, continue and cancel retained commands.                                                  |                                                   |
| 9   | A cancelled prerequisite drops its edge and notifies the Architect, instead of holding.                                                                                                                                                                                     | 5 plans, 5 nodes                                  |
| 10  | Shrink outcome delivery to queued, then delivered. Stop emitting source-change notices about notices.                                                                                                                                                                       | About 6,200 rows a day                            |
| 11  | `hold()` advertises every action that unblocks it; otherwise it does not hold.                                                                                                                                                                                              |                                                   |

## Execution

The driver owns this work and does it as a direct intervention, after the
stall, Tasks, GPU and voice composition and the per-process core land.

- Items 1 to 6 go first, as one coherent change with migration of the live
  blocked plans.
- Items 7 to 10 follow as deletion passes.
- The contributor contracts, `design/runtime-state-machines.md` and the
  Architect guidance are updated in the same changes.
