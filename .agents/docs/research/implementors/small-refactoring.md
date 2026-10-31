# Small-task / refactoring implementors: evidence and LAZERS application

Research date: 2026-10-31. This report is deliberately narrow: it covers focused
coding changes and refactors for affordable implementors (Qwen-family coding
models, GLM Flash, GPT-6 Luna, and Claude Sonnet). It does not claim that one
prompt is optimal for every model, or that public benchmark scores predict a
specific OpenCode session.

## Findings with evidence strength

### 1. Repository instruction files can hurt when they add requirements

Two related studies must be kept separate. Gloaguen et al.'s ETH/LogicStar
study (arXiv 2602.11988, v3) built CTXbench with **138 Python instances from 12
repositories**, and also evaluated SWE-bench tasks with generated context files.
Across its settings, it reports no general success-rate improvement and **over
20% higher inference cost on average**. On CTXbench, developer-written context
files outperformed generated ones by 7% on average, but both increased
exploration/testing; the authors recommend keeping only non-standard practices
that are not already documented. This is evidence against putting a task
authoring manual, broad repository overview, and implementation recipe in every
worker prompt.

- [Gloaguen et al., “Evaluating AGENTS.md” (arXiv)](https://arxiv.org/abs/2602.11988)
- [Full paper text, CTXbench details](https://arxiv.org/html/2602.11988)

Khatri's separate REALM 2026 study used **17 real tasks from three repositories,
288 runs, and two agents**. Its equivalence test bounded any correctness change
from context strategy to ≤10–15 percentage points; its failure triage found
implementation skill (feature design, pattern choice, exact wiring), rather than
missing repository facts, was the dominant issue. It did **not** establish the
20% cost figure above. The studies agree that irrelevant requirements are risky,
but use different datasets and answer different questions.

- [Khatri, “Do Context Files Help Coding Agents?” (ACL Anthology)](https://aclanthology.org/2026.realm-1.5/)

Limits: neither study uses our Luna/GLM/Qwen OpenCode setup, and both task sets
are small relative to all repositories. The evidence supports removing
irrelevant or duplicated instructions; it does not support omitting task-specific
facts, focused code examples, or required repository conventions.

### 2. Outcome-first prompts leave useful implementation freedom

OpenAI's current prompting guidance says coding prompts should define the target
outcome, success criteria, constraints and available context, then let the model
choose the path. It explicitly advises against long, absolute, step-by-step
recipes except for true invariants. Its Goals guidance says well-scoped coding
tasks do not need a bigger prompt and should have a measurable outcome,
verification surface and constraints.

- [OpenAI prompting guide: outcome-first prompts](https://github.com/openai/skills/blob/main/skills/.system/openai-docs/references/prompting-guide.md)
- [OpenAI: using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

Limits: vendor guidance is not a controlled comparison of prompt lengths. Treat
it as a design recommendation, then validate it against LAZERS trajectories.

Anthropic's coding guidance similarly says Claude performs best with a clear
target to iterate against, such as a test or visual output, and its prompt docs
recommend clear explicit instructions rather than role-play. This supports
goal + observable check + relevant context, not a persona essay.

- [Anthropic Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Anthropic prompt best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

### 3. Repository understanding and interfaces matter more than line count

CABRA evaluated 6,840 coding tasks and reports that tool calls for reading and
analysis predict success better than lines edited; agents often stay strong on
larger tasks by offloading exploration to tools, until difficult cross-module
understanding is required. This supports giving a small model useful starting
points and preserving normal search/read/LSP tools, rather than restricting reads
to write scope or stuffing an entire repository into the prompt.

- [CABRA: Code Understanding is a Bottleneck for Coding Agents](https://www.kirantomlinson.com/publication/2026-balepur-cabra/)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)

Limits: CABRA is an evaluation suite and does not isolate prompt prose from
tool/interface quality. The conclusion is about the combined agent system.

### 4. Refactoring is safest when the behavior boundary is explicit

SWE-Refactor contains 1,099 behavior-preserving refactorings, with 922 atomic
and 177 compound cases. The benchmark prompt includes four useful ingredients:
the transformation description, target method, relevant repository context
(class and caller/callee relations), and the natural-language expected
transformation. Compound refactors are substantially harder; the paper reports
only 39.4% success for a GPT-5.1-Codex agent on compound cases. This supports
classifying a task as small only when the behavior boundary and affected surface
are understandable, not merely because the requested diff sounds short.

- [SWE-Refactor (ICML 2026)](https://arxiv.org/abs/2602.03712)

SWE-Bench ProMax makes the complementary point: serious refactors need precise,
unambiguous issue descriptions and tests reviewed to avoid both narrow tests
that reject valid solutions and broad tests that assert unstated requirements.
Its 170 multilingual tasks average 11.4 files and 261.6 changed lines, and the
best reported model resolves 41.2%. Large or compound refactors should therefore
be decomposed by independently verifiable behavior, not forced into the small
persona.

- [SWE-Bench ProMax](https://arxiv.org/abs/2608.09802)

### 5. Model evidence supports capability routing, not model-specific prose

Qwen3-Coder's model card describes long-context repository understanding and
agentic tool calling; OpenRouter lists it as optimized for function calling,
tool use and long-context repository reasoning. GLM-5's paper describes coding,
reasoning and agentic evaluation and an efficiency-oriented long-context design.
OpenRouter's live router benchmark currently shows materially different quality
and cost/task points for GPT-6 Luna, GLM 5.3 Flash and Sonnet-family models, but
those numbers are route-, effort-, benchmark- and date-dependent.

- [Qwen3-Coder model card](https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct)
- [Qwen3-Coder OpenRouter page](https://openrouter.ai/qwen/qwen3-coder)
- [GLM-5 technical report](https://arxiv.org/abs/2602.15763)
- [OpenRouter routing benchmarks](https://openrouter.ai/benchmarks/routers)

The current OpenRouter page is useful for sampling candidates, not for declaring
that Luna is universally best or Flash universally cheap: its displayed values
can change and hosted routes differ from OpenCode Go subscription accounting.
Compare matched LAZERS tasks using accepted outcome, rework, elapsed time and
actual reported usage; do not route solely on list price or a benchmark average.

Practitioner reports are directional only. A Qwen3-Coder discussion reports strong
coding but fragile tool calling in some local wrappers; GLM Flash discussions
report both good value and occasional looping/rate-limit/provider variance. These
are hypotheses about harness/provider behavior, not model facts.

- [Qwen3-Coder practitioner discussion](https://www.reddit.com/r/LocalLLaMA/comments/1mn00j3/talking_with_qwen3_coder_30b/)
- [GLM Flash provider discussion](https://www.reddit.com/r/openrouter/comments/1wh31rd/anyone_else_facing-glm53flash-rate-limitfailure/)

## Three implementor personas (maximum)

Personas are routing labels and tiny role overlays, not separate long system
prompts. The common implementor definition should own normal coding tools,
Code Mode, diagnostics/LSP where the host provides them, write-scope enforcement
and the requirement to run relevant checks and report prose. The persona only
changes what kind of task is a good fit and what evidence is expected.

### Small / Refactoring

Best fit: one behavior-preserving fix or localized transformation; one subsystem
or a few directly related files; existing tests/patterns make the intended result
legible. Good candidates include a parser/helper extraction, an error-path fix,
a migration of one call site, or a narrowly scoped API compatibility change.

Do not use this label for a cross-cutting migration, a new subsystem, or a task
whose acceptance requires several coordinated behavioral decisions. Split those
by verified outcomes or route to Systems.

Minimal overlay: “Preserve existing behavior except where the task says otherwise.
Find the closest existing pattern, make the smallest coherent change, and run
the focused checks plus the normal quality check. If the requested refactor would
change behavior or reveal a missing contract, stop and report it instead of
silently broadening scope.”

Mini-skill guidance belongs in the task, not in the persona. Use at most a few
sentences: **reuse** (the closest symbol/test), **pitfall** (the failure mode and
why it matters), **practice** (the check or invariant that catches it), and a
source path. It is advisory unless promoted to acceptance/constraint.

### Systems

Best fit: state, persistence, concurrency, integration, or cross-module work
where failure modes and compatibility boundaries matter. The task should expose
the contract and likely failure cases, with focused interfaces/tests, while
leaving implementation choices to the worker. Use a stronger model or split the
graph when the work combines independent outcomes.

Minimal overlay: “Trace the existing contract and neighboring tests before
editing. Preserve compatibility and failure atomicity. Exercise the material
concurrency/recovery/error paths and report any unresolved design decision.”

### UI

Best fit: user-visible behavior with a reference, existing design system or
observable interaction states. Supply the reference and required states; do not
dictate every component, CSS declaration or file location. Verification includes
the running UI or screenshots plus relevant tests.

Minimal overlay: “Match the repository's existing visual language and the stated
reference. Implement the required interaction, loading/empty/error states and
accessible behavior; inspect the running result and correct visible regressions.”

These overlays should be injected only when the routed task is in that persona;
they should not be copied into Architect or all task records.

## Small/refactoring task template

Use this as a writing shape, not a schema-bound script:

```text
Goal
<one or two sentences: observable change and why it matters>

Done when
- <behavior that must hold>
- <material failure/compatibility case>

Boundaries
<only necessary write scope, compatibility requirement, and exclusion>

Implementation guidance (advisory)
Reuse: <closest existing code/test>
Pitfall: <specific failure mode; why it matters>
Practice: <one check or invariant>
Source: <path or focused context reference>

Verification
<focused test/check plus the repository quality check when appropriate>
```

Example:

```text
Goal
Extract the retry-key normalization from submission handling so every replay
path compares the same validated identity without changing existing task data.

Done when
- Replaying the same key and content returns the original task ID.
- Changed content conflicts and does not mutate the original record.
- Existing submission validation, permissions and tests still pass.

Boundaries
Submission identity only; do not change scheduling, workers or UI.

Implementation guidance (advisory)
Reuse the existing validated submission path and its transaction tests. Pitfall:
normalizing arrays or object values differently across lookup and insert can make
valid replays conflict. Practice: cover replay, conflict and a fresh-process
lookup with the existing storage test helpers. Source: src/submission.ts,
src/storage.ts and their tests.

Verification
Run the focused submission tests and the repository's normal format, lint and
type checks.
```

The template is intentionally short. A strong Architect may add one more
code-grounded pitfall or split the work when the guidance itself exposes a second
independently verifiable outcome. It should not prescribe table names, helper
names, command order, line edits or a speculative test matrix.

## Schema alignment for LAZERS

The current Zod schema already has the right conceptual separation: `objective`,
`acceptance`, `writeScope`/`constraints`/`exclusions`, optional `guidance`, and
`verification`. Keep JSON Schema validation, cross-field evidence references,
`lazers_verify_task`, and the Architect's System One self-review. Those are
mechanical correctness checks, not source hashing or model approval.

Recommended schema/presentation adjustments:

1. Treat `objective`, `acceptance`, `writeScope` and `verification` as the core
   execution contract. Keep `guidance` optional. Continue allowing empty
   `constraints`, `exclusions`, `assumptions`, `context`, `capabilities` and
   `skills`; do not populate them with boilerplate.
2. Keep `guidance` one advisory string (or a small structured equivalent) rather
   than adding separate mandatory `pitfalls`, `bestPractices`, and `references`
   arrays. A compact mini-skill is useful; a second taxonomy would increase
   authoring and rendering burden.
3. Keep `acceptance` behavioral and observable. An assertion should not repeat a
   constraint or prescribe an implementation step. Prefer roughly 2–5 assertions
   for a small task as an authoring heuristic, not a validator or hard word gate;
   larger counts are a decomposition signal for Architect review.
4. Preserve typed verification IDs and evidence links. A command alone is not
   evidence for a UI or behavior claim; acceptance can cite an artifact or human
   decision where runtime observation is required.
5. Keep `writeScope` as the runtime safety boundary, but do not turn it into a
   read restriction. Workers need normal search/read/LSP access to understand a
   focused change; runtime reviews the resulting artifact against scope.
6. Keep model/persona selection in the execution plan (`workerModel`/variant and
   routing policy), not in task prose. Task content should describe the work and
   evidence; model selection should use observed trajectories and current model
   metadata.

The current renderer places done conditions before guidance, which is correct.
Avoid rendering repository-wide policy, all skills, or historical constraints as
task-specific instructions. Required skill content should be attached only when
the plan names it. This preserves the useful mini-skill without turning every
worker prompt into a handbook.

## Dogfood experiment to validate the hypothesis

Use fixed starting revisions and identical acceptance/evidence for three real
task shapes: one small refactor, one small bug/error path, and one small UI state.
Run the concise template with the same OpenCode tools through Luna Max, Qwen or
GLM Flash, and Sonnet where available. Keep Architect/model routing constant for
the first comparison. Record each trajectory's accepted result, focused checks,
regressions, scope violations, rework/repair, elapsed time, tool calls, input
tokens, output/reasoning tokens, cache usage and API-equivalent price estimate.

Grade first on acceptance correctness and regressions, then on necessary rework,
latency and total cost. A shorter prompt is a win only if it preserves the same
external acceptance. Compare failures and repairs, not successful attempts alone.
After each run, have Architect review only the task draft and trajectory: remove
unsupported obligations, add a missing code-grounded pitfall when the trace
demonstrates one, or split the task if the failure reveals multiple outcomes.
Do not add generic rules because one model made an isolated mistake.

This experiment tests the task/harness combination. It does not establish that
Luna, Qwen, GLM Flash or Sonnet is globally superior; current OpenRouter prices,
provider routes and subscription accounting are separate measurements.

## Application to this repository

- Keep the implementor definition short and operational. It already tells the
  worker to fetch the typed task, use normal tools, apply advisory guidance,
  verify and commit. Do not move persona-specific recipes into
  `src/implementor.md`.
- Keep `guidance` and the balanced self-review checks in `src/task.ts` and
  `src/webgpu/review-questions.ts`; the review should remove unsupported,
  repeated or implementation-prescriptive text as well as find missing behavior.
- Treat the historical LAZERS tasks as training data to rewrite, not as prompts
  to replay verbatim. Preserve their acceptance intent and required boundaries;
  move repository facts and proven pitfalls into concise guidance.
- Continue using Repomix/focused retrieval and native tools to deliver source,
  interfaces and tests. The evidence says targeted context and usable tools are
  more valuable than a giant worker instruction block.
- Keep `lazers_verify_task`, JSON schema validation, real tests and observed app
  behavior. Remove only unsupported ceremony such as source-hash evidence or
  invented execution budgets.
