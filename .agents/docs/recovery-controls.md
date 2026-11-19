# Recovery controls

These native tools provide a manual, source-attached recovery workflow before
Tasks UI/RPC and automatic delivery are available. All records live in the
project SQLite database and remain separate from task acceptance, scheduler
state, and writer authority.

## Concern and follow-up

1. Inspect an exact source attempt with `lz-inspect-recovery`.
2. Attach or update a concern with `lz-record-recovery-concern`. Supply a stable
   `concernID`, an idempotent `requestID` (or let the native call ID identify the
   request), a bounded evidence list, and the
   inclusive sequence boundary that evidence covers.
3. Record an Architect decision with `lz-disposition-recovery-concern`. An
   acknowledgement names the reviewed boundary; a follow-up names either an ISO
   time or a concrete condition. Both preserve the source version and decision
   history. Neither creates a scheduled wake.

The source attempt, task/spec revision, workspace, worker session, and current
plan owner are validated by the store. Read-only inspection does not prompt or
change runtime state. Automatic concern detection/notification and due-follow-up
wakes are deferred to linked delivery work.

## Evidence-based recovery decisions

For a consequential continuation, steering, scope, handoff, or proposed takeover
decision, put a concise rationale in the ordinary disposition reason and cite
supporting evidence. Reuse measured usage and progress from `lz-inspect-trajectory`
when they inform the decision. Include market-valued cost only when an applicable
configured price source supports it; report missing usage or valuation as unknown,
never zero, and treat session-reported charges as diagnostics rather than market
rates. State progress or remaining work as unknown when the available evidence
does not establish them. Weigh failed approaches, demonstrated progress, scope
growth, retained value, and bounded remaining work. Compare the value and effort
of the current worker's next useful step with the coordination and continuation
overhead of continuing, handing off, or taking over. Prefer finishing a bounded
useful outcome in the current worker when the evidence supports it; new findings
do not automatically expand scope, and sunk effort is not a reason to continue.
Record the next observable result or condition (or a specific time) that will
trigger reassessment. Do not invent quotas or automatically escalate to a
frontier/model tier; a takeover or model change requires an explicit Architect
decision and any needed authorization.

A concise rationale can say: “Continue this worker because [observed progress and
retained value], after [failed approaches]; measured usage is [evidence or
unknown] and market-valued cost is [source/value or unknown]. Remaining work is
[bounded work or unknown]; compare the current worker's next step with
[coordination/continuation overhead]. Reassess when [observable result or
condition].” Use only decision-relevant facts and references; this is not a new
valuation or retrospective subsystem.

## Same-worker checkpoint

`lz-checkpoint-recovery-worker` requires an Architect-owned concern on the exact
latest running attempt. It persists the command and native message ID before
steering, validates the target session's project, agent, and workspace, and uses
native synthetic delivery with `delivery: "steer"`. The instruction explicitly
asks the worker to continue the same task and workspace.

The stored state distinguishes prepared, admitted, unknown admission, observed
consumption, and a structured response. An ambiguous admission is never resent
under the same request ID. A response is associated only when the assigned
worker's native context contains that exact synthetic message before the response
tool call. This is evidence of context ordering, not proof that the model
understood the message or that the workspace is quiescent. Replacement attempts
cannot receive a checkpoint prepared for an older attempt.

After a response, inspect new evidence and reassess the agreed outcome. If the
same failure persists at the agreed condition, investigate and decide whether to
request a durable handoff. Continue only when there is concrete progress or a
materially new approach; time, token/tool counts, and repeated advice are not
progress criteria.

## Durable handoff

1. Architect calls `lz-request-handoff` for the source attempt and provides its
   returned `requestID` to the worker. This explicit request is persisted; it does
   not automatically notify the worker.
2. The assigned source worker sends the complete structured handoff data to
   `lz-verify-handoff`. It persists an immutable draft and runs the existing
   focused review, returning the exact `draftVersion`, `reviewID` and `round`.
   Disabled or unavailable review is recorded as a limitation, never a semantic
   pass.
3. The worker calls `lz-submit-handoff` with those returned identifiers and a
   stable `finalizationID`. It finalizes that exact reviewed version and preserves
   the durable report. There is no separate public draft-submission or third
   finalization tool. The current Architect can then record an appended
   correction with `lz-disposition-handoff`.
4. `lz-read-handoff` retrieves the attached request, bounded drafts/reports,
   corrections, and paged history for the current plan Architect or exact source
   worker.

An Architect reviewing or recovering an existing reservation calls
`lz-verify-handoff` with its `requestID`, `draftVersion`, evidence, and exact
`reviewID`. This reads and reviews the persisted worker-authored draft; the
Architect cannot create or replace draft data. Finalize the exact returned
result with `lz-submit-handoff`, including its `fingerprint` when available.
Durable authorization records identify the current Architect's review without
rewriting the original round reviewer or outcome.

Reports and corrections preserve the original source task/attempt. They do not
prove completion, stopped writes/background work, or authorize another writer.
Use runtime tools for execution transitions and task acceptance.

## Evidence and limitations

The registered-tool behavior tests exercise persistence, append order,
idempotent replay, source ownership, native admission, context association, and
handoff review/read paths using fixtures and a fake native host. In production,
matching synthetic response IDs and native context ordering are observed facts;
they are not a general guarantee of model consumption or worker quiescence.
Automatic concern notification, automatic due-follow-up wakes, Tasks UI/RPC, and
execution-authority transitions are intentionally not implemented here.
