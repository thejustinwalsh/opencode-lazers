# Evidence-wait runtime recovery

Real context task `430e08d8` returned and passed its registered native context
observation. The task's evidence wait nevertheless exposed two runtime gaps:

- `hold()` unconditionally incremented plan version and recorded/notified the
  same block every tick. The plan reached version 306 while its node was still
  verifying the same `native:human` condition. This makes model-driven
  expected-version commands stale even without any new work.
- Combined acceptance can require human/native observation evidence, but the
  existing command required a task ID and only stored task-scoped evidence.
  The combined check reads plan-scoped evidence (`task_id IS NULL`), leaving no
  command capable of closing that declared condition.

`a07377c` records blocked state/outcome only when state or reason changes, in one
transaction. The regression holds committed work at a real evidence wait across
repeated ticks, checks stable version/transition/outbox counts, then uses the
original expected version to record evidence and reconciles to acceptance.
Sixty runtime/recovery tests passed before native activation. All nine loaded
native locations reloaded through the supported API with PID 16786 unchanged.
A subsequent, later graph-evidence wait stayed at version 318 across 3.1 seconds;
that observation is not a separate native reproduction of the task-wait path.

`a771bc3` lets the existing `human-evidence` action omit taskID for a plan
assertion. It derives the current combination from accepted task artifacts and
binds the declared human assertion to that exact result. Early recording,
wrong artifacts and wrong task/plan scope are rejected. Replaying a successful
request is idempotent; recording evidence does not force acceptance or bypass
checks. Normal reconcile/verification completes the plan. The combined tree
passed 272 tests / 2,566 assertions, formatting, lint and strict TypeScript.
The canonical location alone was then reactivated for this command lane.

## Native queue recovery

The churn left 303 queued synthetics when first inspected. Root preflight later
found 293 obsolete matches among 295 entries. At apply time, one had already
been consumed: 292 candidates among 294 entries were individually rechecked and
cancelled through native `session.inbox.cancel`, leaving two current synthetics.
There were no cancellation races in that apply run.

Selection required the exact Architect session/project/plan owner, an accepted
context task, a queued synthetic described as a LAZERS task outcome, a message ID
in that plan's durable outbox, exact native text matching `outcomeText(payload)`,
and the obsolete task-level native-evidence reason/version. No unrelated entry
matched. The outbox and transcript were not rewritten or deleted. The adjacent
JSON retains the inspected identities and all successful cancellation IDs.
This was bounded recovery of the observed incident; it adds no historical inbox
sweep or weaker ownership rule to production coalescing.

The cause of prior renderer freezes remains unresolved. These observations prove
notification/version churn and its recovery, not a renderer-hang diagnosis.
