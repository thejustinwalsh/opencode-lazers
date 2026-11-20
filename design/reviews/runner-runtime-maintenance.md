# Runner runtime maintenance

`TaskRuntime` (`runtime.ts`) is the coordinator: it builds the modules, owns the tick
order (`runTick`, `reconcilePlan`) and the shared tick state, and exposes the public
API. Every other workflow lives in a module below. The runner modules
below own execution for their respective workflows. They receive the store,
host, and callbacks needed to use the existing lease, lifecycle transitions,
and outcome records.

| Module                               | Responsibility                                                         |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `retained-verification-execution.ts` | Retained candidate checks, isolated workspaces, acceptance and cleanup |
| `adoption-execution.ts`              | Descendant adoption, candidate workspaces and checks                   |
| `worktree-cleanup.ts`                | Quiescence, ownership, removal and cleanup retries                     |
| `plan-control.ts`                    | Scheduling, pause controls and recorded integration                    |
| `outcome-delivery.ts`                | Native inbox observation, delivery, replacement and ownership transfer |

The `TaskRuntime` split (plan: `.agents/plans/runtime-split.md`) added these modules. Each is a
class built with a `RuntimeCore` (`runtime-core.ts`) and a dependency object whose calls into
other modules are lazy arrows; modules import each other with `import type` only.

| Module                                 | Responsibility                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `runtime-journal.ts`                   | `hold`, `outcome`, `effect`, `receipt`, `supersedeEffect`, `uncertain`         |
| `runtime-helpers.ts`                   | Shared types and pure helpers                                                  |
| `check-activities.ts`                  | Check activities, deadlines, targets, cancelled retained checks                |
| `architect-ownership.ts`               | Architect validity, owner adoption, route, session title                       |
| `architect-sources.ts`                 | Source observation, invalidation, continuity, the source scan                  |
| `architect-renewal.ts`                 | Session renewal and its lock                                                   |
| `worker-observation.ts`                | Worker events, approval and background waits, `backgroundBlockReason`          |
| `cleanup-audit.ts`                     | Cleanup audit diagnostics                                                      |
| `effect-reconciliation.ts`             | Reconciling an effect by kind; settling a matched check                        |
| `verification-candidate.ts`            | Candidate preparation, check effects, automatic fixes, the profile fix chain   |
| `verification-review.ts`               | `verify`, scope review, Fallow and Auditor reviews, repair availability        |
| `plan-finish.ts`                       | Combined plan check, plan Fallow review, acceptance                            |
| `startup-settlement.ts`                | Startup settlement and recovery                                                |
| `continuation-preparation.ts`          | Terminal, resume and combined-verification continuation checks                 |
| `adoption-preparation.ts`              | Adoption fingerprints, baseline and scope checks, preparing an adoption        |
| `retained-repair-records.ts`           | Stored repair, generation, prompt check, transition history                    |
| `retained-verification-preparation.ts` | Retained verification candidate preparation                                    |
| `retained-repair-preparation.ts`       | Retained repair, its recovery and review-input reconciliation                  |
| `dispatch.ts`                          | Dependencies, route resolution, capacity and prompt admission                  |
| `worker-preparation.ts`                | Adopting a running worker; preparing a worker                                  |
| `attempt-advance.ts`                   | Advancing a running attempt, stale attempts, auto-resume                       |
| `cancellation.ts`                      | Cancelling workers and settling a cancelled plan                               |
| `queue-review.ts`                      | Queue review requests, Fallow configuration holds                              |
| `command-pipeline.ts`                  | Command admission, preparation, the retry on a moved plan, the transaction     |
| `commands-control.ts`                  | Run, cancel, reassign, takeover handlers                                       |
| `commands-scope.ts`                    | Scope amendment and divergence handlers                                        |
| `commands-retained.ts`                 | Retained repair, adoption, retained verification, startup settlement handlers  |
| `commands-recovery.ts`                 | Resume, retry, requeue, startup recovery, shared workspace, reconcile handlers |
| `plan-step.ts`                         | One scheduler step for one plan                                                |

Measured at the end of the split (`main`): `runtime.ts` is 1,319 lines (12,769 before); the
largest module is `verification-candidate.ts` at 1,114 lines (it gained the profile fix chain),
then `startup-settlement.ts` at 875. Fallow over `runtime.ts` and all of the modules above:
50 complexity findings (worst cognitive 85, cyclomatic 105), 15 clone groups, 0 import cycles, 0
unused exports. The split moved code and did not change it, so the findings moved with it.

Use the bundled Fallow dependency or `lz-fallow-report` before and after
refactoring. Compare duplication across all touched modules so moving a clone
does not count as removing it. Read the cited callers before removing
dead-code findings, especially native registrations and recovery paths.
Run `bun run verify` and the affected runner behavior tests.

The first split consolidated five copies of the retained-verification generation
and state check and two paths that record the same setup cleanup failure. Fallow 3.41.0 reported 41 clone groups touching the original
runtime and 33 touching the runtime plus all extracted modules after the split.
The plan-control extraction shares one target-branch and artifact ancestry check
for task and plan integration. `CommandPipeline` retains the transaction.

The health report flagged `TaskRuntime.command` as a complexity hotspot before the split; the pipeline and
its handler modules now carry it. Use its existing command families to guide further extraction
and preserve the common version check and transaction when moving handlers.
