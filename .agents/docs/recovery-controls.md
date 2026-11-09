# Recovery controls

These native tools provide a manual, source-attached recovery workflow before
Tasks UI/RPC and automatic delivery are available. All records live in the
project SQLite database and remain separate from task acceptance, scheduler
state, and writer authority.

## Concern and follow-up

1. Inspect an exact source attempt with `lz-inspect-recovery`.
2. Attach or update a concern with `lz-record-recovery-concern`. Supply a stable
   `concernID`, an idempotent `requestID` (or let the native call ID identify the
   request), the current `expectedVersion`, a bounded evidence list, and the
   inclusive sequence boundary that evidence covers.
3. Record an Architect decision with `lz-disposition-recovery-concern`. An
   acknowledgement names the reviewed boundary; a follow-up names either an ISO
   time or a concrete condition. Both preserve the source version and decision
   history. Neither creates a scheduled wake.

The source attempt, task/spec revision, workspace, worker session, and current
plan owner are validated by the store. Read-only inspection does not prompt or
change runtime state. Automatic concern detection/notification and due-follow-up
wakes are deferred to linked delivery work.

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
2. The assigned source worker saves an immutable structured draft with
   `lz-submit-handoff`.
3. The worker or Architect runs `lz-verify-handoff` against the exact draft. The
   existing focused review policy is reused. Disabled or unavailable review is
   recorded as a limitation and is never reported as a successful semantic pass.
4. Finalize the reviewed draft with `lz-finalize-handoff`, then let the current
   Architect record an expected-version correction with
   `lz-disposition-handoff`.
5. `lz-read-handoff` retrieves the attached request, bounded drafts/reports,
   corrections, and paged history for the current plan Architect or exact source
   worker.

Reports and corrections preserve the original source task/attempt. They do not
prove completion, stopped writes/background work, or authorize another writer.
Use runtime tools for execution transitions and task acceptance.

## Evidence and limitations

The registered-tool behavior tests exercise persistence, version conflicts,
idempotent replay, source ownership, native admission, context association, and
handoff review/read paths using fixtures and a fake native host. In production,
matching synthetic response IDs and native context ordering are observed facts;
they are not a general guarantee of model consumption or worker quiescence.
Automatic concern notification, automatic due-follow-up wakes, Tasks UI/RPC, and
execution-authority transitions are intentionally not implemented here.
