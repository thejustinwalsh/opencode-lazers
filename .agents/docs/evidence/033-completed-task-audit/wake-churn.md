# Architect wake churn audit

Read-only audit of the durable runner outbox, current native adapter, OpenCode V2 inbox API, and the live SQLite records. No source, Desktop, settings, or database writes were made.

## Direct evidence

The latest completed Qwen plan is `8d505ab3-e279-4c54-bd0f-dc5169f228e9`, now `integrated` at version 10. Its durable transitions are:

- version 7: task `7548e7f8…` accepted; outbox status `task-accepted`, `resume=1`;
- version 8: combined plan accepted; outbox status `accepted`, `resume=1`;
- version 10: worktrees reconciled/integrated; outbox status `integrated`, `resume=0`.

All three outbox rows target Architect session `ses_e6e0e6239ffdtzIePMeJ1sHA4l` and are marked `delivered`. Thus one successful plan intentionally creates two independent resumable notices, followed by a non-resumable integrated notice. If the first two synthetic inputs were already queued or consumed before the final state, the Architect can wake more than once and later report that the plan was already handled/resolved.

The current `TaskRuntime.outcome()` fingerprints the full payload, which includes plan version and status. `INSERT OR IGNORE` therefore removes exact replay duplicates only; it does not supersede earlier statuses. `deliver()` selects every non-delivered row and calls `host.notify()` without comparing an older payload with the plan's current state or with other pending outcomes. It marks a row delivered when `session.synthetic()` accepts it, which is host inbox admission, not proof that a model turn has consumed it.

`nativeHost.notify()` currently sends `session.synthetic({id,text,resume,delivery:"queue"})`. It adds no metadata identifying the plan/status and does not inspect the native inbox. OpenCode V2 exposes public `session.inbox.list`, `session.inbox.cancel`, and `session.inbox.update`; inbox entries include synthetic payload text/metadata and an inbox ID. The current adapter uses none of these operations.

Existing test `accepted task handoff resumes review...` explicitly expects both the task-accepted and accepted notifications to have `resume: true`, so the observed duplicate wake behavior is protected by the current test contract. The current runner recovery tests prove durable outbox replay and stable message IDs, but not stale-status suppression or queued-inbox coalescing.

## Why the queued progress/lifecycle work does not cover it

The active progress plan `b9e55d09…` records a durable automatic-fact/commentary recorder and explicitly says missing lifecycle coverage remains. It does not change runner outcome delivery or native inbox behavior. The Architect context lifecycle plan concerns ownership transfer/archive. Neither plan owns stale outcome coalescing. This is a narrow delivery repair, not a new scheduler or model loop.

## Smallest mechanical repair

Keep every runner outbox row and stable ID for recovery/audit. Coalesce only the native inbox wake surface:

1. Mark runner outcome synthetic inputs with metadata such as `lazersKind: "runner-outcome"`, `planID`, `status`, and outbox/message ID.
2. Before enqueueing a newer LAZERS outcome for a plan, list that Architect session's inbox and cancel only still-queued synthetic LAZERS outcomes for the same plan. Do not inspect or retract delivered transcript messages, user inputs, or worker inputs. The newest outcome remains the one queued.
3. Use `session.inbox.cancel` failures as delivery uncertainty; do not silently discard the current notification. Durable outbox rows remain intact. This preserves lost-response/restart recovery while preventing a queued `accepted` notice from waking after a later `integrated` notice.
4. Treat task-level acceptance as progress unless it is the current unresolved action: the combined `accepted` outcome is the plan-level review/synthesis wake. The existing test should be changed to assert one action wake for a successful plan while retaining durable task-level outcome history.

The native cancellation step is necessary because once a synthetic is admitted to OpenCode's inbox, changing only SQLite cannot retract it. Coalescing in SQLite alone prevents future sends but cannot remove an already queued native resume. Conversely, native cancellation alone does not alter durable evidence or hide the prior outcome.

A later hardening can add a runtime stale check before host admission, but it should not relabel a suppressed row as `delivered` without a distinct durable `superseded` fact. The first repair should avoid conflating “persisted,” “host admitted,” “cancelled as superseded,” and “model consumed.”
