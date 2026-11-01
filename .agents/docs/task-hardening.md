# Advisory task hardening

Implemented for the optional WebGPU experiment, OpenCode 2.2.5, 2026-10-31. This records the user's agreed progress policy, not a claim that the local reviewer is SOTA or certifies a task.

## Intent and boundary

Give the primary agent a cheap opportunity to improve a task before submission. One native tool, `lazers_verify_task`, owns structural validation, the fixed question collection, review history, and progression. The agent supplies structured task state, receives one focused concern, revises the task or obtains a clarification, and calls the same tool again. It does not choose a model or write the review questions.

The reviewer is advisory. The main agent remains responsible for the specification and user intent. Ordinary `lazers_submit_task` performs its existing strict structural validation and persistence. Its API is unchanged; this increment guides Architect to verify before submission, rather than adding an opaque semantic veto to task persistence. Direct submission clients are not forcibly intercepted. Review completion never authorizes execution or establishes acceptance.

Coverage is task-local: judge acceptance against the task objective and its
boundaries, not every outcome in the parent roadmap. Cancellation/performance
checks apply when this task owns that behavior. Retain the original request as
intent evidence; combined feature coverage belongs to the plan. Checklist changes
invalidate prior judgments and return guidance to start a fresh review.

## Agreed state machine

At most **three verification rounds total per review ID**, including the initial round. Each changed-state round evaluates the independent checks together (split into bounded transport batches if necessary), then chooses one pending concern in checklist order for feedback.

| Observation                                                       | Recorded disposition                          | Next action                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Relevant check scores at least 0.7                                | `resolved`                                    | Advance                                                                        |
| Applicability question scores at most 0.3                         | `not_applicable`                              | Advance                                                                        |
| Revised focused check scores equal or better than its prior score | `non_regressed`                               | Advance while retaining the concern                                            |
| Check remains worse or unsettled, with rounds available           | `pending`                                     | Return targeted feedback; revise or clarify                                    |
| Third round is reached with remaining concerns                    | `limit`                                       | Continue with concerns                                                         |
| Inference fails                                                   | Explicit error; score/probability unavailable | Retry within the same bound; at the limit continue with an explicit limitation |

This intentionally favors forward progress with a small imperfect model. Equal-or-better advancement and continuation at the limit are product policy, not proof that the judged proposition is true. No average “task quality” score replaces individual questions. Each Noul's score is `P(yes)` or `1-P(yes)` according to that question's declared good direction. The 0.7/0.3 thresholds are provisional starting values, not calibrated workload guarantees.

Every revision rechecks the current task, including previously resolved concerns. Regressions can reopen a concern. A previously advanced `non_regressed` check stays advanced only while its score remains no worse. Question IDs hash their definition, so changing a question's subject does not inherit another question's baseline.

An unchanged successful-feedback request replays its prior result without consuming a round or inventing progress. Failed inference may retry unchanged state within the bound. A completed review is valid only for its fingerprint; a changed terminal draft returns `stale`. Original request text remains fixed; add actual user answers to evidence. Never fabricate answers to improve scores.

## Questions and structured state

Question wording, directions, applicability, and correction instructions live together in `src/webgpu/review-questions.ts`. Preserve concrete judgments:

- Does acceptance explicitly cover the requested behavior?
- Does acceptance explicitly cover cancellation, when requested?
- Does acceptance state a measurable performance target, when improved execution speed is requested?
- For each acceptance assertion: could its proposed verification pass while that assertion is false?
- For each exclusion and constraint: does implementing the objective conflict with that specific statement?
- For each assumption: does recorded intent or evidence establish that specific assumption?
- For each acceptance assertion: does delivering it require work outside the permitted scope?

All are separate named Noul questions. Applicability questions are separate from coverage questions. Each result keeps its question, target path, raw probability, direction-normalized score, and disposition. Code selects the next concern and returns its specific correction instruction. The model is never asked to decide whether the workflow should advance.

The model receives JSON `{task, intent: {request}, evidence}`. Evidence should include relevant repository facts, recorded clarifications, and proposed test procedures or source excerpts. A command such as `bun test` alone cannot establish that a test checks the claimed behavior. The model does not inspect files itself, execute tests, or infer unavailable repository facts reliably. Calling agents must supply the relevant evidence and treat ambiguity accordingly.

Independent questions share a request; a dependent later stage needs updated state. The correction loop is agent feedback and changed-state reevaluation, not repeated identical requests or majority voting. This follows the [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), [fan-out pattern](https://docs.typesafe.ai/patterns/fan-out), [Liquid model card](https://huggingface.co/LiquidAI/d1-Omni-2B), and [reference API](https://huggingface.co/LiquidAI/d1-Omni-2B/blob/main/api.py). The user's advisory progress rules deliberately permit unresolved findings.

## Tool contract

```ts
lazers_verify_task({
  task: taskProposalJSON,
  request: originalUserRequest,
  evidence: [recordedClarification, relevantTestProcedure],
  // Omit initially; reuse the returned ID on revisions:
  reviewID,
})
```

Results:

- `invalid`: fix structural/bound errors; no inference round was consumed.
- `feedback`: follow `focus.guidance` and `next.instruction`, then reuse this review ID with changed task/evidence.
- `unavailable`: model/transport failure is explicit; retry when appropriate or report the limitation.
- `completed`: all checked concerns resolved or did not apply; proceed to ordinary submission.
- `completed_with_concerns`: proceed under the agreed advisory policy, retaining findings and errors.
- `busy`: a call for this review is active; wait for it to finish.
- `stale`: this completed review belongs to another draft; verify the new draft separately.

Nothing is submitted by the verifier. The original task-submission tool remains the persistence boundary. Native permission `lazers_verify_task` is asserted before review-state access or inference. Architect receives that permission and review guidance only when the local-inference master, System One decisions, and Task review switches are on. Disabling review removes its tool/guidance and cancels its local inference while ordinary submission and the core task workflow remain available. See [feature controls](webgpu-api.md#feature-controls).

## User communication

Review mechanics belong in the structured tool results and retained diagnostic evidence. The tool description, every tool result's `communication` instruction, and the optional Architect system guidance tell the agent to omit round counts, internal question IDs, fingerprints, scores, dispositions, and raw state from ordinary replies. Users can still explicitly request diagnostics or expand native tool results; this is agent communication guidance, not a redaction or access boundary.

The agent repairs issues itself when the request and evidence support the correction. It asks one concise native clarification when missing information or a material user decision prevents a sound repair, without inventing an answer to satisfy the reviewer. Ordinary completion is one or two short sentences describing useful task improvements and any material unresolved concern in plain language; detailed reports are opt-in. Next-tool routing and progression/budget mechanics stay in the tool results. It must not claim advisory completion proves correctness or that proposed tests were executed. The earlier retained trial explicitly requested round-by-round diagnostics; its verbose final reply is not the normal presentation contract.

A retained [fresh-context rehearsal](../evidence/task-hardening/presentation-2026-10-31.json) produced a two-sentence final reply without internal IDs, scores, or status names, after three actual review calls. The speech selector matched exactly that final visible text. The primary model still condensed specific unresolved verification/scope findings into a generic unexecuted-test concern; the latest guidance explicitly forbids that substitution. This remains an evaluation target, not a claim of guaranteed model obedience. A reused diagnostic conversation had also echoed a status literal, motivating explicit per-request diagnostic guidance.

## Bounds and evidence

- Three rounds, 64 concrete checks, at most 16 questions per inference batch, 60-second inclusive round deadline.
- Existing local transport limit: 8,000 serialized characters per batch; oversized state fails explicitly, with no truncation.
- Review records persist through the host's plugin storage under `task-review.<UUID>`, scoped additionally to canonical project, session, and agent. In-flight calls have a 120-second stale-call lease. A crashed attempt consumes its reserved round; exhaustion continues with an interrupted-review concern.
- Records retain the supplied states and structured results for up to three rounds, checklist version, question definitions, model/checkpoint revision, fingerprints, probabilities, dispositions, and measured usage. They contain task/evidence text and stay in plugin storage. No automatic upload or fine-tuning occurs. Future training needs independently reviewed labels; model answers and non-regression are not ground truth.
- Review histories are not attached to the submitted TaskSpec in this increment. Durable submission linkage and UI display are separate follow-ups.
- The store has no cross-process compare-and-swap API. The tool serializes a review in its host plugin instance and uses a persisted lease across reloads. It does not claim distributed transaction guarantees.

Verification covers transitions, schema rejection, unchanged replay, later regressions, ownership, concurrency in one instance, persisted resumption, third-round continuation, stale terminal drafts, and explicit inference failures. Model-quality benefit remains unproven; the [parallel evaluation handoff](parallel-task-review-evaluation.md) defines the next phase.

The retained [Desktop trial](../evidence/task-hardening/live-2026-10-31.json) shows Architect using this single tool for three successive drafts: behavior-coverage feedback, cancellation-coverage feedback, then completion with one remaining verification concern. The agent strengthened the proposed acceptance/test plan, did not claim execution, and did not submit. Local tool elapsed times were 6.46s, 2.78s, and 3.12s. Unit verification: 53 tests / 313 assertions passed across the full repository, including nine review-specific tests; native Bun formatting, lint, and typechecking passed.
