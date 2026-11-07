# Architect tasking tune

## Scope

Correct task composition while preserving research, intent clarification,
interview, planning, source discovery, model/persona routing, self-review and
native LAZERS execution. No state-machine replacement or new task-size gate.

## History findings

- Root's repeated small-increment steering and the old instruction to split
  independently verifiable changes encouraged overly fine boundaries.
- LZ-179/180 represent the same outcome with a test-scope correction; that is
  coordination overhead, not two delivered features.179 had no attempt.
- Architect consolidated zero-attempt170/171,148/149 and160/161 into181,182 and183
  through existing tools. These are useful end-to-end outcomes. However, the
  submitted proposals still contain8/7/7 acceptance assertions and8/9/6 constraints,
  respectively. Their serialized whitespace counts are roughly1076/1134/976 words
  (JSON formatting is not tokenizer usage). Many clauses carry prior task text.
  Consolidating by concatenation preserves verbosity and cognitive overhead.
- Active180 has substantive source and public-path tests; its end-to-end test
  exposed a real failure under correction. Diff size alone is not a task grade.
- Retained172 source is now under isolated review with rendered chart captures.
  Waiting for review/integration is a separate delivery problem, not grounds to
  subdivide a completed implementation.

## Applied prompt changes

Only the task-composition section of `src/architect.md` is changed in this tune:
research/interview → clear intent → plan → outcome/dependency-based task units;
feature default, coherent bugs/refactors, shared context/interfaces, related
implementation/fixes/tests with one worker, and meaningful verification boundaries.
Acceptance expresses behavior; edits and regression cases remain implementation
and verification details. Consolidation reconciles requirements by meaning rather
than concatenating old specifications. Task-specific constraints remain; generic
runtime safeguards and coordination history stay in their existing systems.

The task-authoring guide now states the same rule without accumulating another
overlapping paragraph. Detailed research remains a linked reference:
[seven-paper synthesis](llm-work-decomposition-research-20261107.md).

The Understand section, classification, routing, submission, continuity and
review/integration guidance remain intact. Optional System One guidance/tool,
review progression, schemas, runtime checks, permissions and state machine are
unchanged by this tune. No tests or live acceptance obligations were removed.

## Verification and limits

`bun run verify` passed with automatic formatting/lint and strict typecheck.
The native Architect registration test passed:1test,26assertions.

Read-only `client.agent.get` at Unix ms1794081053922 confirmed the actual loaded
Architect contains feature-default, internal-step, plan-before-task and requirement
deduplication guidance, plus research, native clarification and `lz-verify-task`.
Normal wildcard tool access remains. Loaded definition including optional review
guidance was1096 whitespace-separated words; this is not a token count.

This proves registration, preservation and live loading, not reliable future
tasking. Observe the next real task composition and implementor result. Existing
consolidated records predate the latest deduplication change; do not claim their
verbosity was already fixed or create another cancellation/resubmission loop
merely to demonstrate new wording. Preserve running workers and retained source.
