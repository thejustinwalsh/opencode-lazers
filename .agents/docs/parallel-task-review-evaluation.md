# Next parallel phase: measure the hardening loop

Question: Does the small local decision model's targeted feedback improve task specifications enough to justify its latency and false alarms, compared with the same agent reviewing its own task?

Increment: A reproducible evaluation suite and a retain/revise/discard report. This phase measures the implemented policy; it does not tune the runtime while measuring it.

Starting context: Read `AGENTS.md`, `README.md`, `task-hardening.md`, `webgpu-api.md`, `src/webgpu/review-questions.ts`, and `src/webgpu/task-review.ts`. The main agent is the stronger reasoner. Local d1 provides advisory signals. Keep the agreed three-round total bound, equal-or-better advancement, and continuation with recorded concerns at exhaustion.

For the local-review condition, enable local inference, System One decisions, and Task review in Settings → LAZERS. Record the complete feature settings with trial metadata. An intentionally disabled capability is not a model-quality failure; ordinary task workflow must continue without local review in that condition.

Permitted writes: `test/review-eval/**`, `scripts/evaluate-task-review.ts`, `.agents/evidence/task-review-eval/**`, and `.agents/docs/task-review-evaluation.md`. Runtime/UI/task-storage files are read-only in this phase, making this work compatible with the main dogfood session. Report a needed runtime fix with reproduction rather than modifying shared sources. Use an isolated Desktop profile and stable plugin snapshot for live trials; do not drive the main dogfood window or rebuild its bundle.

Build a labeled fixture set with at least 12 concise structured task cases: complete proposals, a visible mic with missing cancellation behavior, measurable versus vague performance targets, a test that checks only icon presence while behavior is broken, conflicting action/exclusion pairs, an unsupported assumption, a scope mismatch, and ambiguous evidence. Include clean lookalikes so the reviewer can incur false alarms. Store expected judgments and short source-grounded rationales; mark labels provisional until human reviewed. Keep four cases held out from wording/threshold development.

Compare three conditions on eight fixed agent tasks, using the same host model/settings and starting inputs:

1. Structural validation only.
2. Structural validation plus the fixed checklist given directly to the agent.
3. Structural validation plus the local System One hardening tool.

The comparison isolates the value of the checklist from the value of the extra model. Record initial/final task JSON, actual tool payloads/results, review IDs, round counts, local checkpoint/checklist versions, errors, latency, host tokens/cost when available, and exact vs estimated measurements. Never label a policy advance as a resolved semantic defect. Record newly introduced defects as well as fixes.

Acceptance: A one-shot fixture/schema scorer, retained raw synthetic evidence for the trials, and a report of defects repaired, false alarms, unresolved concerns, clarification frequency, regressions, rounds, and latency. Score the final drafts using the fixture's external criteria rather than d1's own approval. State all limits of the sample; eight trials per condition establish pilot evidence, not statistical certainty. Report findings by question family. Include cases that distinguish a supported automatic repair from a material missing user decision. Check that normal final replies omit internal numbering/scores/state, ask useful clarifications when necessary, and still disclose material unresolved concerns. Keep detailed metrics in evaluation evidence.

Budget: One worker, 90 minutes, at most 24 agent trials and 72 verification rounds, no paid API calls, no model downloads or checkpoint switches. Existing local cached weights and an authorized free/subscription host model only. Stop at the bound and report partial data honestly. One repair of evaluation tooling is allowed; no repeated prompt tuning against held-out cases.

Verification: Bun native formatter/linter/typechecker and meaningful one-shot evaluation tests. Any project-owned listening verification server must follow the Portless skill. Enter live model prompts through Desktop computer use. Read-only evidence export is allowed. Do not submit production tasks, dispatch workers, train weights, create PRs, or alter the main task store.

Decision: Retain if feedback fixes useful defects without excessive false alarms/regressions for its cost. Otherwise identify the failing question families, state omissions, or runtime limitations and propose the smallest next change. Fine-tuning and automatic training-data export remain separate phases after trustworthy labels and a useful baseline exist.

Suggested opening prompt for the parallel session: “Implement the bounded evaluation phase in `.agents/docs/parallel-task-review-evaluation.md`. Keep all writes in its permitted paths, preserve the deployed review policy, and deliver measured pilot evidence and a retain/revise/discard recommendation.”
