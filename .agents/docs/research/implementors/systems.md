# Systems implementors: research findings for LAZERS

Research snapshot: 2026-10-31. This note covers backend, persistence, concurrency, recovery and API tasks. It separates measured results from vendor claims and anecdotal reports. Model names and prices change; refresh the catalog before routing work.

## What the evidence says about task writing

**Controlled studies and benchmark evidence**

- SWE-agent's ACI paper and implementation show that the interface and feedback loop matter substantially. Their concrete findings include a syntax-checking edit path, a bounded file viewer, concise search results and explicit success for empty command output. The result is evidence for better tools and feedback, not for longer task prose. [SWE-agent paper](https://arxiv.org/abs/2405.15793), [ACI design notes](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md)
- Agentless reached 32% on SWE-bench Lite at about $0.70 per issue with a simple localization → repair → validation pipeline. Its result is a useful challenge to elaborate autonomous loops: first give the model a clear problem, relevant locations and a real verifier. It does not establish that all tasks should be agentless or that a short prompt always wins. [Agentless](https://arxiv.org/abs/2407.01489)
- A 176-setting harness study varied planning, tools and context management across SWE-bench Verified and Terminal-Bench 2.1. Planning helped weaker models stay alive long enough to edit, while stronger models mainly used it to avoid redundant verification. Predefined tools helped bash-weak models; bash-capable models were cheaper with a bash-only interface. Context management mattered most when context was tight; staged elision before summarization was the strongest efficiency strategy. These are reasons to classify models and tune the harness, not to add universal constraints to every task. [Harness design study](https://huggingface.co/papers/2609.20804)
- SWE-ContextBench found that correctly selected, compact summaries improved accuracy and reduced runtime and token cost on related tasks, while unfiltered or incorrectly selected experience gave little or negative benefit. This supports Repomix maps, focused reads and relevant mini-skills; it argues against attaching every prior transcript to a worker. [SWE-ContextBench](https://arxiv.org/abs/2602.08316)
- SWE-Bench Pro is a useful warning about long-horizon systems work. It uses human-verified, augmented problems and reports public-set resolution below 25% even for frontier models; the older Qwen-3 32B baseline resolved 3.4%, Sonnet 4 17.6%, and GPT-5 23.3% under one scaffold. Its trajectory analysis found Qwen's failures dominated by tool errors (42%), while Sonnet's failures were dominated by context overflow and excessive file reading. The benchmark is older than today's models and does not predict OpenCode Go performance, but it supports decomposition by independently verifiable outcome and strong tool contracts. [SWE-Bench Pro](https://arxiv.org/abs/2509.16941)

**First-party guidance and model-card claims**

- Anthropic's context-engineering guidance describes a useful middle altitude: clear and direct instructions, enough information to remove ambiguity, and flexibility for the agent to choose routine implementation details. It explicitly warns against both brittle prompt logic and vague goals, recommends the smallest high-signal context, and favors just-in-time retrieval over loading a whole corpus. It also recommends canonical examples instead of a laundry list of edge cases. This is first-party guidance and an engineering observation, not an independent controlled study. [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- OpenAI's reasoning guidance says reasoning models perform best with straightforward, brief prompts; state the end goal and success criteria precisely, use delimiters, and avoid asking for chain-of-thought. It distinguishes planners for ambiguity from lower-latency workhorses for well-defined execution. This is provider guidance, not a cross-provider benchmark. [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)

**Current public measurements and model cards**

- SWE-rebench's current public slice (111 problems, 65 repositories) reports agent-plus-model results with cost and token usage. The rows most relevant to value routing are: GLM-5.2 high 62.9% / $1.40 / 5.52M tokens; GPT-5.6 Luna medium 43.6% / $0.11 / 0.396M; Qwen3.6-27B 31.2% / $0.62 / 3.08M; DeepSeek-V4 Pro high 40.2% / $0.15 / 3.96M; Sonnet 5 high 56.8% / $1.43 / 4.65M. These are not model-only scores, are from a particular harness and date window, and include caching. Use them as routing signals, not guarantees. [SWE-rebench leaderboard](https://swe-rebench.com/)
- Search-SWE gives direct but narrow evidence for the exact model family we care about: `openai/gpt-6-luna` at max reasoning ranked first on 47 search-engine-building tasks with a 16.4 mean score and 1.07B coding tokens in a Codex v0.164/OpenRouter harness. DeepSeek V4.1 Flash scored 15.5 with 2.42B tokens; GLM-5.3 Flash scored 1.3 with 4.69B tokens. The task domain is building search systems, each model has one selected evaluation per task, and the score is not a code-pass rate, so this is evidence for a Systems hypothesis only—not general coding superiority or a proof that Luna is always cheaper. [Search-SWE leaderboard](https://search-swe.github.io/leaderboard/), [GPT-6 Luna entry](https://search-swe.github.io/leaderboard/entries/2026-10-31-local-1233340bbd-gpt-6-luna-max/)
- Qwen's current Qwen3.8-27B card reports, under the Claude Code harness, 73.0 on Terminal-Bench 2.1, 61.7 on SWE-bench Pro and 79.0 on its in-house QwenSWEBench. Those are author-reported results with a 256K context and specified sampling; they are not directly comparable to SWE-rebench's Qwen3.6 row. The card says the model supports tool calling and recommends contemporary serving engines. [Qwen3.8-27B card](https://huggingface.co/Qwen/Qwen3.8-27B-FP8/blob/main/README.md)
- Qwen3-Coder-Next's card describes tool calling, scaffold adaptation, error detection/recovery and 256K context as design goals, with 3B active parameters in an 80B MoE. This is a model-author capability claim; verify the exact hosted variant in OpenCode before relying on it. [Qwen3-Coder-Next card](https://huggingface.co/Qwen/Qwen3-Coder-Next)
- GLM-5.3-Flash's card claims 320B total / 18B active parameters, redesigned for efficiency, with hybrid sparse and linear attention. OpenRouter describes it as suited to efficient coding and long-horizon agent tasks. These are vendor/catalog claims, not independent solve-rate evidence; consult the catalog observed on 2026-10-31 for current route prices rather than copying prices into policy. [GLM-5.3-Flash card](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/README.md), [OpenRouter API catalog](https://openrouter.ai/api/v1/models)
- DeepSeek-V4-Flash's card describes a 284B model with 13B active parameters and a one-million-token context, and documents vLLM/SGLang/OpenAI-compatible serving. The public SWE-rebench row is for V4 Pro, not Flash; route Flash only after a matched dogfood trial. [DeepSeek-V4-Flash card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)
- OpenRouter describes Kimi K2.7 Code as coding-focused, tool-capable, always-thinking and 262K context. It is a plausible systems specialist when long-horizon reasoning matters; consult the catalog observed on 2026-10-31 for current route prices and measure whether the quality gain justifies them. [Kimi K2.7 Code](https://openrouter.ai/moonshotai/kimi-k2.7-code), [OpenRouter API catalog](https://openrouter.ai/api/v1/models)
- The exact subscription model is **GPT-6 Luna Max** (benchmark slug `openai/gpt-6-luna`, max reasoning), not GPT-6.1 Luna. Search-SWE is direct public evidence for that model, but only on search-system construction; do not substitute GPT-5.6 Luna or another route when reporting our dogfood.

Community reports are useful for hypotheses but are not ground truth. Recent Reddit discussions commonly report that Qwen coding variants are fast and cheap for bounded edits but weaker at debugging/recovery, while stronger reasoning variants do better on multi-step fixes. Those are self-selected anecdotes with inconsistent harnesses; use them to choose an ablation, never as a routing rule. [Example discussion](https://www.reddit.com/r/LocalLLaMA/comments/1m6qdet/qwen3coder_is_here/)

## Implications for LAZERS

Task quality is a contract problem and a context-selection problem. The Architect should research the repository, write the observable destination, and add only code-grounded knowledge that the implementor would otherwise have to rediscover. The task should not encode a private implementation plan, imagined quotas, source hashes or a complete worker playbook.

The useful distinction is:

- **Requirement:** externally observable behavior, compatibility, scope and failure semantics. These are mandatory.
- **Guidance:** a local mini-skill derived from the repository: what to reuse, a real trap, why it matters and where the evidence is. The worker may choose another implementation if it preserves the contract.
- **Verification:** tests, type checks, runtime observations or other checks that demonstrate the required behavior. A model's self-review can find omissions; it is not evidence that code works.

When a draft becomes hard to read, the Architect should first ask whether it contains multiple independently verifiable outcomes. If so, split by outcome and dependency. If the outcome is inherently coupled, retain one task and move routine decisions into guidance. Splitting by file count or adding line-by-line instructions repeats the failure we are correcting.

## Three provisional implementor personas

Keep the catalog to three personas. Personas select a model/harness and a way to present context; they do not remove ordinary coding tools or permit worker subagents. The scheduler owns dispatch and parallelism.

| Persona                      | Best fit                                                                                            | Prompt/context emphasis                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Systems**                  | Persistence, APIs, state machines, concurrency, recovery, migrations and integration boundaries     | State invariants and failure behavior first. Supply focused call paths, schema/API references, one or two repository pitfalls and real verification commands. Prefer a model with reliable tool use and recovery. |
| **UI**                       | Component behavior, visual states, accessibility, theme integration and browser/runtime interaction | State user-visible behavior and reference states. Supply the component entry point, design tokens and a visual/runtime check. Avoid prescribing markup or CSS structure unless compatibility requires it.         |
| **Small task / refactoring** | Local bug fixes, tests, narrow migrations, cleanup and mechanical changes                           | Keep the change boundary tight, give the failing behavior and nearby example, and let the worker choose the smallest patch. Fast workhorse models are appropriate.                                                |

The Systems persona should use normal OpenCode tools, including shell, editor, tests and LSP where available. It must not launch subagents; the scheduler dispatches any parallel work. A Systems task may ask the worker to commit when the runner's shared-workspace contract requires it, but should not prescribe branch mechanics that belong to the runner.

## Minimal Systems task shape

Use the existing typed fields (`objective`, `acceptance`, `writeScope`/`constraints`/`exclusions`, optional `guidance`, `verification`, and focused `context`). Render the worker-facing form in this order:

```text
Goal
What changes and why it matters.

Done when
Observable behavior, including material success and failure cases.

Boundaries
Relevant compatibility and write scope; explicit exclusions only when they prevent scope drift.

Implementation guidance (optional)
Reuse: existing abstraction or call path.
Pitfall: a repository-specific failure mode.
Why: the consequence and a focused source pointer.

Verification
The checks that demonstrate the done conditions.
```

Each guidance item should earn its place by preventing a known failure or avoiding rediscovery. Prefer a short paragraph or a few bullets over a checklist. Do not add fields for “plan steps,” “budget,” “evidence receipt,” or guessed model limits. Dependencies, workspace mode and worker model stay in the execution plan.

## Example: retry-safe submission

```text
Goal
Make task submission safe to retry when the caller loses the response or the host restarts.

Done when
An explicit submission key identifies one logical submission in a repository. Replaying the key with the same validated content returns the original task ID; changed content conflicts without changing the task. Property order does not matter; array order and values do. Different keys create separate tasks. Concurrent matching submissions create one task. A failed write leaves no task or reserved key. Existing validation, permissions and repository isolation continue to apply.

Boundaries
Submission and its persistence only. Do not change workers, dispatch, scheduling or GUI behavior.

Implementation guidance
Reuse the existing submission tool, transaction helper and repository-scoping path. A response can be lost after commit, so recovery must be based on durable logical identity, not the caller's transcript. Treat the task row and the key claim as one atomic effect; inspect migration and rollback behavior before choosing the storage shape.

Verification
Exercise replay, changed-content conflict, concurrent callers, fresh-process recovery, rollback, migration, permissions and repository isolation. Run the repository's formatter, linter, type checker and tests.
```

This is intentionally a behavioral contract plus one repository mini-skill. It does not dictate table names, helper functions, SQL statements or a sequence of edits. The implementor can make those choices while the verifier checks the contract.

## How to test whether guidance helps

Use matched, fresh OpenCode sessions on the same starting revision and the same external acceptance checks. Run each representative Systems task with three arms: contract only; contract plus code-grounded guidance; and the historical exhaustive task. Keep the implementor model, tool surface and environment fixed within each comparison. Repeat across Luna Max, GLM-5.3-Flash, Qwen3.8/Coder and Sonnet where available through the user's OpenCode Go/providers.

Record trajectory events rather than inventing an execution budget: tool errors, wrong-directory edits, repeated reads, repair turns, tests run, accepted/rejected artifact, review findings, elapsed time, uncached input, cache reads, output/reasoning tokens and provider-reported cost when available. Grade the resulting change on acceptance correctness, regressions, scope, maintainability and necessary rework. Report total cost per accepted result and failure/rework rates; a cheap failed run is not a win.

Use an ablation for each mini-skill: remove the guidance while retaining the same focused context, then compare whether the worker hits the known pitfall or requires repair. This tests the guidance itself instead of rewarding longer prompts. A result on one task does not establish a model ranking; build a small portfolio covering a migration/recovery task, a concurrency task, a narrow API change and a regression fix.

The first LAZERS worker trace is not a clean prompt-efficiency benchmark because it contains earlier routing and context-delivery failures. Keep it as trajectory evidence, not as proof that the exhaustive task or the corrected prose path is superior. Future fresh runs should make that distinction visible.

## Provisional routing view

Start with the task/persona match, then use live quality and cost traces to update model preference. “Cheap” is not a persona; a model that needs repeated repair can cost more than a slower first pass.

- Systems: Luna Max is the primary OpenCode Go hypothesis, with direct but domain-specific Search-SWE evidence; GLM-5.3-Flash and DeepSeek-V4-Flash are economical long-context candidates; Kimi K2.7 Code or Sonnet is a fallback for difficult recovery/concurrency work when the trace shows a quality gain. Keep context focused and make the verifier mechanical.
- UI: Qwen3.8-27B/Coder and GLM-5.3-Flash are candidates for tool-driven component work; use the UI persona's visual/runtime checks. Route difficult cross-cutting UI changes to a stronger model only when the acceptance surface is broad.
- Small task / refactoring: Luna Max, Qwen or GLM Flash should be sampled first. The task should expose the failing test and local example, with no architecture essay.

These are testable priors, not claims of superiority. OpenRouter exposes current provider prices, context, tool support and latency; use a dated API catalog snapshot rather than hardcoding a static price table. [OpenRouter API catalog](https://openrouter.ai/api/v1/models) (observed 2026-10-31)

### Bottom line

The expert Architect supplies a short contract and a small, repository-specific mini-skill. The harness supplies focused retrieval, useful tools and deterministic verification. Luna Max and other value implementors should be evaluated on accepted work and trajectory cost, not rewarded for following a verbose pseudo-implementation plan.
