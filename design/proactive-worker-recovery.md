# Proactive worker recovery implementation handoff

## Goal and authority

Implement the user's agreed recovery flow: deterministic runtime rules detect a
possible struggle, notify the owning Architect with evidence, and let Architect
decide whether to check in, follow up later, or let the worker continue. Architect
can investigate and steer the existing worker. Continued struggle after steering
returns to Architect for a handoff and reconciliation, followed by completing the
task or creating linked work to finish it.

This feature is authorized for implementation through the driving thread's
existing native Architect and LAZERS workflow. Preserve its wider roadmap and
active work. This handoff defines product behavior and acceptance; Architect
should inspect current source, reuse existing tasks where applicable, and choose
small coherent increments and their integration order.

The scheduler owns observation, delivery, follow-up scheduling, durable state and
execution transitions. Architect owns interpretation, investigation and recovery
decisions. Workers implement and report facts. Commentary and model judgments do
not establish acceptance.

## Read first and current source findings

Follow `AGENTS.md`, `README.md`, `.agents/docs/task-authoring.md`, the pinned
`.agents/docs/opencode-api.md`, and the latest `.agents/docs/handoff.md` and
`.agents/docs/roadmap-execution.md`. Runtime state supersedes timestamped handoffs.
The source findings below were inspected on 2026-11-01; recheck before editing.

| Existing capability                      | Entry point and useful boundary                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker progress and native event capture | `src/progress/native.ts`, `recorder.ts`, `schema.ts`, `projection.ts`: records tool/session events, retries, usage and concise commentary. Current commentary input is one message of at most 1,200 characters.                                                             |
| Idle handoff signal                      | `src/progress/native.ts`: `experimental.idle` requests missing final prose through a persisted synthetic message with `delivery: "steer"`. Identity/admission reconciliation prevents recursive reminders. It does not detect active struggle or establish handoff quality. |
| Native proof of reporting                | `.agents/docs/evidence/018-durable-progress/native.md`: real report/event roundtrip; complete native reminder/restart coverage is not established.                                                                                                                          |
| Runtime execution and recovery           | `src/runner/runtime.ts`, `machine.ts`, `store.ts`, `schema.ts`: observes busy workers and usage; busy execution currently returns without struggle evaluation. Verification repair, stopped-attempt resume/retry and reconciliation already exist.                          |
| Outcome notification                     | `src/runner/outcome.ts`, `inbox.ts`, `native.ts`: durable owned notifications, coalescing and native admission handling. Queued/admitted/consumed are different facts.                                                                                                      |
| Worker guidance                          | `src/runner/host.ts` exposes durable keyed `updateInstruction`; inspect its native implementation. An instruction upsert does not itself prompt, resume, or prove worker consumption.                                                                                       |
| Trajectory inspection                    | `src/trajectory/*` and `src/observability/*`: bounded visible evidence and privacy rules. Inspect current live-history repairs before depending on them.                                                                                                                    |
| Agent responsibilities                   | `src/architect.md`, `src/implementor.md`: Architect has normal investigation tools; runtime owns dispatch. Implementors have normal coding tools and do not delegate.                                                                                                       |

Existing Architect idle renewal concerns ownership and conversation continuity;
it is separate from worker struggle detection. Integrate with current ownership
without treating unfinished renewal work as delivered or replacing its task.

## Deferred owner, renewal and cache policy

The user's 2026-11-05 priority remains Models pricing, then Tasks/Trajectory and
Radar. Current queued delivery follows LZ-150 → LZ-151 → LZ-152 for pricing and
LZ-138 → LZ-88 → LZ-148 → LZ-149 for Tasks/Trajectory, with LZ-147 independent
and existing runtime prerequisites preserved. LZ-57 continues independently. An
existing idle Architect is waiting, not lost; do not infer missing ownership or
manually wake it solely because it is idle while workers progress. Existing
configured renewal remains runtime-owned.

Eventually consolidate missing-owner recovery, idle renewal and provider/model-aware
cache policy in this existing planning lane. Keep that work behind overdue
features unless a concrete delivery blocker emerges. This note does not authorize
a broad refactor, a new foundation task or duplication of current work. Address a
concrete blocker with the smallest supported correction while preserving existing
ownership, worker history, native evidence and resource holds.

## Required behavior

### Detect a concern and retain its evidence

Evaluate relevant new events incrementally. Persist a versioned rule identity,
the exact plan/task/attempt/session, an evidence interval or sequence watermark,
and the observable reason a rule matched. Use deterministic, explainable rules;
do not run a model on every event or repeatedly load full transcripts.

Incremental observation includes changes to previously seen records, not only
inserts. `ProgressRecorder` coalesces observations into existing rows whose `seq`
and often `at` remain unchanged. A sequence-only insertion watermark must not miss
a later terminal failure on an already-seen call. Reuse supported hooks/change
tracking and retain a durable change boundary that survives replay/reopening;
coordinate this with Radar recency without treating snapshot timestamps as a
guaranteed update cursor.

Start with signals current evidence can support, such as repeated equivalent
tool/check failures after attempted correction, repeated unsuccessful edit
operations, or an unmet follow-up/check-in expectation. Architect should specify
the initial supported rule families and their thresholds after source inspection.
Keep thresholds distinct from token, time, tool-call or spend quotas. A long run,
large context, repeated reads or high usage alone does not establish failure.

Classify provider retries, permission/user waits, dependency/scope waits, running
checks/background work, and implementation failures separately. Healthy work
must not be interrupted merely because it is long or temporarily quiet. If a
signal needs information not currently captured, add the smallest justified hook
or structured checkpoint and document why existing facts are insufficient.

### Notify Architect and keep the worker running

Deliver a concise concern to the current authorized Architect through the durable
runtime notification path. Include identity, rule/reason, bounded evidence
references and summaries, current execution/wait status, and prior interventions.
Expose deeper evidence progressively through existing tools. Do not include
hidden reasoning, credentials, transport envelopes or raw full contexts.

Detection alone does not cancel, pause, retry, change a route, rewrite a task, or
remove a workspace. Revalidate current ownership and attempt state when delivering
and acting. Handle an Architect that is busy, replaced, missing or unavailable
without losing the concern or waking stale owners into duplicate actions.

### Let Architect disposition the concern

Provide validated runtime actions for these decisions, with a concise reason:

- **Let it cook:** acknowledge the evidence already reviewed and allow work to
  continue. Suppress repeat notifications for that evidence, while allowing
  materially new evidence or a new incident to trigger another concern.
- **Follow up later:** persist a concrete future condition or due time and the
  evidence boundary to reassess. Reevaluate after restart; do not rely on an
  in-memory timer or an unrecorded promise to check later.
- **Check in now:** send a tracked request to the existing worker for completed
  work, attempted approaches, current failures/blockers and its next approach.

Keep concern/intervention states separate from the task execution state machine.
These actions need stable request identities, expected versions and permission
checks consistent with existing runtime commands. Stale or replayed decisions
must not create duplicate messages or affect a replacement attempt.

### Investigate and steer the existing worker

Architect may inspect visible trajectories, code, artifacts and check failures,
research relevant information, and gather evidence using normal permitted tools.
It may send focused guidance and request a concise checkpoint from the existing
worker. The worker's message must explicitly say it continues its assigned task
in the same workspace; a check-in is not a completion or surrender request.

A suitable message establishes this meaning without requiring exact wording:

> Continue your assigned task in this workspace. Briefly report what is complete,
> what you tried, what is currently failing or blocking you, and your next
> approach. Apply the following task-specific guidance as you continue: ...

Persist the guidance, delivery identity, intervention/evidence boundary and
follow-up expectation. Distinguish prepared, admitted, consumed and responded
when those facts are observable; otherwise retain an explicit unknown. Do not
claim an instruction was consumed because its native write/readback succeeded.

Self-reporting should occur at useful checkpoints or on request. Add structured
fields only where needed for reliable association or follow-up; avoid mandatory
narration after every tool call. A report is an annotation, and a successful tool
call or changed diff is not by itself proof of meaningful task progress.

Guidance preserves the task contract, worker identity, workspace, route and
history. Changed scope/acceptance or a different execution route requires the
existing explicit authorization and runtime task/plan procedure.

### Reassess and escalate with new evidence

Evaluate the post-intervention event interval and the agreed follow-up condition.
If the same struggle continues or a requested response is missing when due,
notify Architect again with what changed since steering, including any worker
response. The runtime reports observable evidence; Architect judges whether it
amounts to useful progress. Healthy recovery resolves the incident without a
routine extra supervisor turn when the resolution rule is already defined.

Coalesce related evidence, persist acknowledgement watermarks, and prevent
recursive synthetic-message triggers or repeated wakes for an unchanged incident.
Do not let the same unresolved episode become an endless check-in loop. Continued
struggle after steering must expose the handoff/recovery decision; record a reason
and concrete follow-up if Architect chooses further continuation.

### Request a handoff and recover remaining work

Architect may ask the worker to stop at a safe boundary and return a concise
handoff containing completed and partial work, artifact/commit and uncommitted
state, approaches tried, current failure and supporting evidence, checks run and
still needed, and suggested remaining work. Retain it durably with provenance.
If the worker cannot respond, expose that fact and reconcile available evidence;
do not fabricate a worker-authored handoff or wait indefinitely without a recorded
follow-up/action.

Before another actor writes overlapping code, confirm the old writer and owned
background work are stopped or otherwise safely reconciled through supported
runtime/native operations. A handoff message alone is not proof of quiescence.
Preserve dirty/unmerged work, original attempts, receipts and measured usage.

Architect may finish the remaining scoped task, or reconcile the original task
and create a linked set of tasks/dependencies for what remains. Track direct
Architect implementation as recovery work and apply normal scope, artifact and
runtime verification/acceptance rules. Reuse valid existing evidence only when
its artifact, inputs, command and environment still match. Do not force acceptance
or mark superseded/cancelled work fulfilled. Use current supported task links/new
specifications rather than silently mutating immutable historical acceptance.

## Acceptance and verification

Apply the [recovery handoff and clarification addendum](recovery-handoff-contract.md)
within this work: DB-attached source-task handoffs, the existing three-round
System One hardening/forward-progress policy, Architect clarification decisions,
and actual delivery of failure context to continuing or replacement workers.

Architect should map these feature-level assertions to task and combined-plan
evidence, with focused checks at task boundaries and broad integration checks at
the combined boundary:

1. A supported repeated-failure fixture deterministically creates one concern
   with reproducible evidence; healthy/waiting/provider-retry lookalikes are
   classified correctly and do not spuriously trigger implementation recovery.
2. A concern reaches the current Architect while the original worker keeps its
   attempt/session/workspace/route and continues. Duplicate events, ticks and
   notification acknowledgements do not produce duplicate incidents or actions.
3. All three dispositions work. A deferred follow-up survives reopening; an
   acknowledgement suppresses old evidence without suppressing new concerns.
4. Check-in and focused guidance reach the correct worker. Record actual response
   association and unknown delivery/consumption separately. Check-ins and
   responses cannot recursively trigger more check-ins.
5. Continued post-steering failure produces a second actionable concern carrying
   the new evidence and prior guidance. Demonstrate both successful recovery and
   escalation to handoff; a resolved/terminal task receives no stale steering.
6. Handoff recovery preserves partial/dirty work, usage and history, prevents
   overlapping writers, and supports finishing or linked replacement tasking
   through ordinary verification. Test missing-response and uncertain-effect
   cases, stale/foreign callers, owner changes and cancellation races.
7. Event replay, duplicate delivery, crash/reopen and ambiguous native admission
   cannot duplicate worker messages or recovery side effects. Durable commands
   remain fenced to current identities and versions.
8. Record a real native Desktop flow from concern through Architect disposition,
   worker check-in/guidance and response, followed by observed reassessment.
   Identify which recovery/escalation branches were observed live and which are
   fixture-only. Do not fabricate production failures or treat mocked delivery,
   a queued message, or a passing build as native consumption proof.
9. Retain the incremental observation/read cost, concern/wake/message counts,
   intervention outcome, usage and elapsed time where available. Include failed
   recoveries and Architect effort when attributable; unknowns remain unknown.
   A successful pilot establishes feasibility, not comparative savings.

Use meaningful Bun behavior tests, including real disposable SQLite/runtime
fixtures for durability and command races. Run Bun native formatter, linter and
strict typechecker plus relevant integration checks. Load `$portless-dev-servers`
before any project listening verification server. Coordinate native activation
and GUI builds with the driving thread's active work and inference state.

## Delivery boundaries

Keep one plugin, the existing scheduler, native sessions/worktrees, exact model
routes, permission checks and privacy guarantees. No separate watchdog service,
per-event model supervisor, autonomous model ranking, new execution quotas,
mandatory retrospective, broad dashboard or full-transcript polling is needed.
Expose only the tools/inspection needed to use and audit recovery; panel polish
can remain separate.

Reinspect active reservations and owned files before dispatch. Existing lifecycle,
trajectory and scheduler repairs may overlap these entry points. Integrate their
reviewed behavior and retain their native gates; do not reset, clone or replace
active work simply to implement this feature. Record implemented, native-observed
and still-unproven behavior separately in the driving thread's final handoff.
