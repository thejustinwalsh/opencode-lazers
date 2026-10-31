# Implementor profiles and task research

Research snapshot: 2026-10-31. Four research lanes covered UI, systems,
refactoring and model value. These are task classifications and candidate tests,
not established model rankings or extra primary agents. The runtime has one
hidden implementor with optional short per-task persona overlays.

## Three profiles

| Profile                      | Suitable work                                                                  | Task-specific context                                                           | Completion evidence                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Small task / refactoring** | Local bug, bounded behavior-preserving transformation, narrow API migration    | Reproduction or target behavior, nearby pattern, affected callers when material | Focused regression or preservation checks; normal repository checks                                     |
| **Systems**                  | Persistence, concurrency, state, recovery, cross-module contracts              | Relevant interfaces, invariants, failure semantics, proven repository pitfalls  | Checks that distinguish correct success/failure/recovery behavior; integration observation where needed |
| **UI**                       | Existing component changes, layout, interactions, theme and visual integration | Approved reference, relevant viewport/states, component and token entry points  | Running interaction checks **and** visual comparison; build success alone is insufficient               |

Classification follows the acceptance surface, not file count or a model brand.
Compound refactors can be Systems work. A backend dependency of a UI feature can
be a separate Systems task when it has independent acceptance. Do not split a
coherent change solely to create more agents.

The common implementor retains normal coding tools, Code Mode and available
diagnostics. Scheduler owns dispatch and parallelism; workers do not delegate.
The optional per-task overlay supplies only its distinct execution emphasis:

- Small task / refactoring: preserve behavior outside the requested change;
  inspect the closest pattern and demonstrate the intended difference.
- Systems: trace the contract and exercise material failure and recovery paths.
- UI: inspect the reference and existing primitives; run the interaction and
  compare rendered states at the relevant viewport.

These are concise design candidates, not three additional instruction manuals.
Do not inject every profile into every task.

The runtime exposes these as optional per-node choices (`ui`, `systems`, and
`small-refactoring`), with at most one short overlay on an attempt. A persona is
independent of provider/model/effort; it neither assigns a model nor restricts
normal tools. The live native catalog and the user's preferences can inform a
route question, but no capability field or missing catalog entry is a LAZERS
route veto. Preserve explicit provider/model/variant values for native execution.

## What the research supports

[Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) found no general success
improvement and over 20% higher inference cost on average across its settings.
That is evidence against unnecessary repository instructions, not against useful
local facts. [SWE-ContextBench](https://arxiv.org/abs/2602.08316) found selected
summaries useful while irrelevant experience could hurt. Together they support
**selective, code-grounded mini skills**, rather than repeating a repository tour.

[SWE-agent](https://arxiv.org/abs/2405.15793) demonstrates the importance of tool
interfaces and feedback. [Agentless](https://arxiv.org/abs/2407.01489) shows that
focused localization, repair and validation can be effective. Neither establishes
an optimal task length for today's models. [SWE-Refactor](https://arxiv.org/abs/2602.03712)
distinguishes atomic and compound transformations: preserve behavior and supply
material caller/context information, rather than equating a short request with an
easy task. [VISTA](https://arxiv.org/abs/2605.26144) measures the gap between visual
presence and functioning interactions; UI acceptance must inspect both.

The task format remains [Goal → Done when → Boundaries → optional Guidance →
Verification](task-authoring.md). Guidance transfers an investigated reuse point,
pitfall and its source. Mandatory behavior stays in acceptance or constraints.
Do not add separate mandatory arrays for best practices, pitfalls or plan steps.
The existing optional `guidance` field and typed evidence references suffice.

[Vendor context guidance](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
also recommends sufficient specific context without brittle recipes. Model cards
explain serving/tool formats and effort settings; those belong to model/harness
configuration, not a different essay in every task. Forum reports about Qwen
mini-skills, GLM reliability and context loops are hypotheses to test, not causal
evidence. The four linked research notes retain positive and negative reports.

## Candidate sampling, not automatic routing

[OpenCode Go](https://opencode.ai/v2/docs/console/go/) includes Luna, GLM Flash,
Qwen and other candidate families. Sonnet is an external comparator, **not in the
documented Go pool**. Current native route, model, effort and capability metadata
can inform advice, but native OpenCode governs whether a route is available; LAZERS
must not veto a selection from catalog metadata. A Qwen checkpoint benchmark does
not establish the behavior of another Qwen Go endpoint.

| Sample                                | Why include it                                                                    | What remains to prove here                                    |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| GPT-6 Luna Max                        | User-selected baseline; direct domain-specific Search-SWE evidence                | Accepted LAZERS work, rework and whole-run efficiency         |
| GLM-5.3-Flash                         | Go availability; favorable older SWE-bench measurement but weak Search-SWE result | Bounded-task reliability, tool recovery, actual latency       |
| Qwen3.8 Flash / Plus                  | Go availability; related model cards cover coding, tools and visual tasks         | Exact route capability and screenshot-grounded UI performance |
| DeepSeek V4.1 Flash / MiMo V2.6 Flash | Value comparators with direct Search-SWE entries                                  | Correctness and total effort on our task mix                  |
| Sonnet, external                      | Useful reference for difficult systems/UI work                                    | Whether a quality/rework gain offsets total cost              |

Do not bind any of these candidates to a persona or infer a global ranking from
these priors. [Vals](https://www.vals.ai/benchmarks/swebench)
is an archived September SWE-bench table; [SWE-rebench](https://swe-rebench.com/)
uses another task window/harness. [Search-SWE](https://search-swe.github.io/leaderboard/)
directly compares Luna Max and Flash candidates on search-engine construction,
with sharply different scores and token use. That disagreement is a reason to
run matched local tasks, not to pick whichever table agrees with a preference.

[OpenRouter's programming collection](https://openrouter.ai/collections/programming)
ranks **adoption**, not coding quality. Its [100T-token research](https://openrouter.ai/state-of-ai/)
describes usage, not accepted software delivery. Its [catalog](https://openrouter.ai/api/v1/models)
is a dated API-equivalent pricing source; Go allowances and subscription charges
remain separate.

## Observation and learning

First grade correctness, regressions, scope and maintainability; record repairs
and driver intervention separately. Compare matched starting code, contract,
tools and external checks, changing one variable at a time. Include unsuccessful
attempts. A single different feature per model cannot establish superiority.

Measure Architect **and** worker usage, uncached input, cache read/write, visible
output, reasoning tokens, tool errors/repeated reads, elapsed time and acceptance.
Price each call using known dated route/tier semantics; missing prices or usage
stay unknown. Report total effort through accepted work alongside failure rate,
not successful-run averages alone. No guessed LAZERS execution quotas are needed.

Change guidance only when a trace exposes a missing fact or recurring pitfall.
Test the advice against the same contract without it. Keep lessons useful and
selective; remove obligations that do not contribute to acceptance.

Detailed source notes: [UI](research/implementors/ui.md),
[Systems](research/implementors/systems.md),
[Small task / refactoring](research/implementors/small-refactoring.md),
[Model value](research/implementors/model-value.md). These are research references,
not worker prompt attachments.
