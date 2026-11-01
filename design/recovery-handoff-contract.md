# Recovery handoff and clarification addendum

## Fold into the authorized recovery work

Extend `design/proactive-worker-recovery.md` and
`design/live-product-verification.md` with a durable, tooling-reviewed recovery
handoff. This is part of their existing diagnosis, steering, handoff and
replacement-worker delivery contracts, not a separate recovery system.

User decisions from this discussion:

- Preserve the desired outcome while correcting a mistaken interpretation,
  unsupported assumption or unsuccessful approach.
- Give a worker asked for a handoff an explicit structured return contract,
  reviewed with the same tooling-assisted pattern used for task specification.
- Attach handoffs to the source failed/struggling task and its attempt, and record
  them in the project database. They must remain available to Architect and
  subsequent agents after the original session/workspace is gone.
- Reuse the existing three-round System One hardening and forward-progress state
  machine policy. Keep unresolved concerns honest while making forward progress.
- Architect investigates and corrects the work; ask the human when new evidence
  requires a material product decision, not for routine implementation repair.

Use the driving thread's native Architect and LAZERS task workflow. Inspect active
plans before changing their breakdown. Add requirements to unstarted work where
supported; use a linked additive task for an already-admitted immutable contract
when needed. Preserve active workers, accepted work, failed attempts and native
gates. Do not reset the roadmap, duplicate research or silently expand a worker's
write scope. Architect chooses the smallest coherent increments and dependencies.

## Current source findings to verify before implementation

Read the two parent handoffs, `README.md`, `AGENTS.md`, the current
`.agents/docs/handoff.md`, `.agents/docs/task-authoring.md`, and pinned
`.agents/docs/opencode-api.md`.

- `.agents/docs/task-hardening.md`, `src/webgpu/task-review.ts` and
  `src/webgpu/review-questions.ts` define current task review: structure first,
  fixed checks, focused feedback, at most three rounds including the initial
  round, equal-or-better advancement, and continuation with retained concerns.
- `src/runner/runtime.ts` records previous-attempt identity/evidence in dispatch
  policy metadata. The inspected native startup prompt requests task instructions
  without an explicit failure briefing. Stored metadata alone is not proof of
  context delivered to the next worker.
- `src/tasks/instructions.ts` renders original specification, assumptions,
  guidance and additive scope. It does not currently render a reviewed recovery
  handoff. `src/tasks/read.ts` exposes attempts/activity through structured reads.
- `src/trajectory/tools.ts` permits permission-checked project-owned failed-attempt
  inspection. This is useful deeper evidence, not guaranteed failure-context
  delivery on dispatch.
- `src/progress/schema.ts` currently accepts one commentary string of at most
  1,200 characters. Durable structured handoffs need their own suitable contract;
  do not overload a progress annotation into task acceptance or a hidden blob.
- `src/runner/roles.ts` rejects implementor tool calls without an active admitted
  assignment. A stopped worker requested to supply a handoff needs a narrowly
  authorized reporting path; do not accidentally restore general write authority
  merely to collect its report.
- `src/task.ts` fixes task revision at 1. `src/task-disposition.ts` records reasons,
  evidence and related task IDs. Reuse supported linked correction/supersession;
  general specification versioning remains separate unless already delivered.

These are source observations from 2026-11-01, not immutable line references.
Reinspect the advancing implementation and reuse current work.

## A structured handoff attached to the source task

Persist the handoff in project SQLite storage with stable identity, source
plan/task/specification revision/attempt, originating request, author/session,
timestamps, schema/review versions and provenance. Derive and validate assignment
identity from the request and native caller; a worker cannot attach a report to
an arbitrary task. Support multiple handoffs on the same task/attempt and preserve
prior versions and their review history. Corrected versions must not overwrite
the claims made by an earlier report.

The database is the authoritative record. Markdown exports and artifact files may
supplement it but cannot be the only handoff. Expose associated handoffs through
task detail/instructions or a focused referenced read, with bounded progressive
access to drafts and review history. Related replacement tasks link back to this
source record rather than relocating or erasing it.

Define concise fields for the following information, using explicit unknown or
not-applicable values where appropriate:

| Information                | Required meaning                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target and contract        | Original outcome and current specification/acceptance references, including applicable decisions already incorporated by Architect. Distinguish user intent from the worker's interpretation. |
| Completed and partial work | Useful changes, commits/artifacts, workspace state and uncommitted work. Keep current observations separate from stale reports.                                                               |
| Approaches and results     | What was attempted, what happened, and the evidence that supports those observations. Do not require hidden reasoning or a transcript dump.                                                   |
| Failure or blocker         | Which behavior/check failed or why evaluation was blocked; distinguish product, implementation, environment and unknown causes.                                                               |
| Assumptions                | Which assumptions remain supported, were contradicted, or are unresolved; associate supporting or conflicting evidence.                                                                       |
| Preserved obligations      | Still-valid requirements, constraints, scope, acceptance and checks that remain necessary.                                                                                                    |
| Next action and decisions  | Proposed correction/options, information needed, and which choices would change behavior, scope, acceptance or authorization.                                                                 |
| Execution ownership        | Recorded writer/background activity and unresolved native effects. A worker claim of stopping is not runtime proof of quiescence.                                                             |

Do not force a confident root-cause explanation when evidence only establishes a
symptom. Preserve hypotheses as hypotheses. Missing information should produce
focused feedback or an explicit concern, not fabricated facts or user answers.

## Reuse task review's three-round state machine

Reuse the current hardening policy and shared implementation where appropriate;
give handoffs their own schema and check collection. A handoff is reviewed for
continuity and recovery usefulness. Task completion remains governed by the
original runtime acceptance and product evidence.

The handoff review must follow the existing semantics:

1. Validate structure, ownership, source references and permitted attachment
   before inference. Invalid structural input does not consume a semantic round.
2. When System One review is enabled, evaluate fixed checks against the handoff,
   source task, original intent/applicable recorded decisions, and supplied evidence. Return one
   focused correction or clarification at a time. Models do not choose the rules
   or runtime transitions.
3. Use at most **three rounds total per review ID, including the initial round**.
   Recheck the changed draft, including previously resolved concerns. Reuse the
   existing equal-or-better/non-regression forward-progress behavior and retain
   concerns that advance without being established as resolved.
4. At exhaustion, persist the handoff with its explicit unresolved concerns and
   pass it to Architect for a decision. Do not start a fresh review ID to evade
   the bound. An unchanged request replays its result under the current policy;
   errors/interrupted rounds use the existing bounded recovery semantics.
5. Retain draft versions, checks, feedback, dispositions, review IDs, errors,
   measured usage/timing and relationships in the DB. Changed source contract,
   evidence or check definitions cannot silently inherit a stale review pass.

Respect existing local-review capability settings. Disabled/unavailable inference
is explicit and follows the existing forward-progress policy; it never becomes a
semantic pass, automatic model fallback or fabricated result. Structural records
and recoverable handoff submission must still function. No new unrelated quotas,
mandatory retrospective or per-event semantic supervisor is needed.

Useful handoff checks include whether it preserves the source outcome, explains
the observed failed approach, identifies relevant unsupported assumptions, points
to evidence, accounts for useful partial work and pending checks, and makes any
material human decision clear. Evaluate evidence quality separately from fluent
prose. Review completion does not establish that these claims are true, that the
worker stopped, that a human approved anything, or that the task succeeded.

## Architect interpretation and human clarification

Architect reads the handoff and its unresolved findings, investigates relevant
source/trajectory/product evidence, and records its disposition and reasoning
summary with evidence references. A handoff does not determine its own recovery.

| Evidence establishes                                                                                                 | Architect response                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Incorrect implementation, clear target                                                                               | Correct/steer or arrange repair without asking the human to debug it.                                                                |
| Unsupported approach, viable alternative preserves the authorized outcome                                            | Investigate and redirect the approach while retaining the task contract.                                                             |
| Task interpretation contradicts a clear original request                                                             | Correct tasking through supported linked work/revision mechanisms; preserve the original request and history.                        |
| Material ambiguity, conflicting constraints, infeasible assumption requiring a changed outcome, or new authorization | Ask one focused native human question with evidence, implications, and useful options.                                               |
| Environment/setup failure                                                                                            | Repair or task the missing capability; do not imply the product intent is wrong or spend an implementation repair on infrastructure. |

Record actual questions and answers with provenance and associate them with the
handoff/recovery decision. Existing user decisions persist; do not ask again just
because an agent/session changed. A question is not answered by silence, a model
guess or a review score. Hold only work dependent on an unresolved decision and
allow independent authorized work to continue. Do not weaken acceptance to turn
a failure into a success.

Architect incorporates the answer's implications into the follow-up task's
objective, acceptance, constraints, scope or guidance through existing tasking
flows where useful. Architect chooses the context the implementer needs, including
source answers when helpful. Prefer existing tasking and context delivery where
they are sufficient; a separate answer-forwarding step is not a requirement.

## Deliver the correction to the next actor

Before continuing work, a resumed/replacement worker must receive an actionable
briefing or explicit readable reference through the actual native execution
path. Include the source handoff/version, observed failure, relevant changed
assumption, what remains valid and Architect's correction. A follow-up task can
carry this through its existing context references and task instructions, with
human decisions reflected in its contract and supporting context included as useful.
This also applies to automatic verification repairs: supply the concrete failed
check and receipt references without requiring Architect reasoning for routine
mechanically defined repairs. Escalate when the failure requires a new decision.

Keep deeper failed-attempt history inspectable progressively. Attach the current
reviewed recovery context separately from the immutable task specification, and
preserve the latest decision/version across compaction, restart and ownership
changes. Distinguish prepared/admitted/read/responded from unknown consumption;
neither `policy.context` storage nor a native instruction readback alone proves
the next model read or applied it.

Use an explicitly selected valid continuation baseline. Preserve access to the
failed work without blindly reintroducing an approach Architect rejected. Same-
worker steering says to continue the task; handoff/takeover obeys the existing
quiescence and reservation contract. A linked replacement task keeps the source
failure/handoff references, original obligations or explicit authorized changes,
and attributable effort across both tasks.

## Acceptance folded into the existing walkthroughs

Add focused checks and observations to the two existing recovery/live-probe work
streams. Do not create an unrelated benchmark campaign or replacement worker just
to produce evidence counts.

1. A handoff persists on its source task/attempt, including original/corrected
   versions and review history; reopen and related-task reads retain the records.
   Foreign, stale, unrelated and replayed submissions cannot misattach or duplicate
   them. Stopped-worker reporting does not grant unauthorized write access.
2. The existing three-round hardening/forward-progress policy works for handoffs:
   focused correction, rechecks/non-regression, unchanged replay, stale review,
   inference failure and honest exhaustion with concerns. A reviewed handoff
   cannot satisfy task acceptance or prove human authorization.
3. A routine code failure gets actionable repair context without an unnecessary
   human question. A genuine changed-outcome decision reaches the native question
   tool, persists the actual answer, and holds dependent work until resolved.
   Architect incorporates the decision into ordinary follow-up tasking; the
   implementer receives the context Architect judges useful. Test investigation-resolvable
   cases, an unknown cause and user rejection too.
4. A continuing/replacement worker actually retrieves the source handoff and the
   current correction through native tools/context, refers to the relevant failure
   evidence and proceeds under the preserved/corrected contract. Retain the read
   or response evidence; test that policy-only storage is insufficient.
5. In existing live walkthroughs, include the handoff request, review result/DB
   attachment, Architect disposition, downstream delivery and subsequent behavior.
   Use an appropriate real case or labelled disposable rehearsal for the human-
   clarification branch; never fabricate an answer or claim a fixture is production
   evidence. State which branches remain fixture-only.

Follow the parent handoffs' tests, privacy, native activation, integration and
cleanup requirements. Update diagnosis/steering/product-verification skills and
project guidance only where this contract adds useful knowledge. The delivery
claim is continuity of evidence and correction from failure into subsequent work;
aggregate model quality or productivity improvements still need their own data.
