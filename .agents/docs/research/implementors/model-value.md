# LAZERS implementor model and task research

**Observed:** 2026-10-31. This is research for routing and dogfood design; it is not a claim that any model will reproduce a public benchmark inside OpenCode.

## What the evidence says

OpenCode Go is a subscription route, not OpenRouter billing. Its documentation says included monthly usage varies by model and that its discounts/reserved capacity are passed through as different usage allowances. The native provider ID is **`opencode-go`**; models are selected as `opencode-go/<model-id>` after `/connect` (for example `opencode-go/gpt-6-luna`). The documented Go catalog includes GPT 6 Luna, Claude Haiku 5.5, GLM-5.3/5.3 Flash, Kimi K3/K2.7 Code, DeepSeek V4.1 Flash/V4 Pro, MiMo V2.6 Flash/Pro, MiniMax M3/M3.1 Flash, Qwen3.8 Max/Flash and Qwen3.7 Plus. **Claude Sonnet is not in the Go catalog**; Sonnet comparisons below are external-route evidence only. Source: [OpenCode Go](https://opencode.ai/v2/docs/console/go/), especially the model list and provider format.

The strongest directly comparable coding evidence I found is Vals AI's 2026-09-01 SWE-bench Verified table. Within that one fixed Mini-SWE-agent harness it reports: DeepSeek V4 Pro 0813 96.4% at $0.10/test and 764k tokens; GPT-5.6 Sol 96.2% at $1.15 and 512k; GLM 5.3 95.4% at $0.34 and 958k; Kimi K3 93.4% at $0.76 and 884k; GPT-5.6 Luna 93.0% at $0.04 and 781k; and GLM 5.3 Flash 92.0% at $0.02 and 793k, with the Flash run taking 1h04m. These are model/snapshot results under that harness, not proof that the corresponding OpenCode Go route uses the same snapshot or prices. Source: [Vals AI SWE-bench Verified](https://www.vals.ai/benchmarks/swebench).

SWE-rebench measures a different harness and a full trajectory. Its current table puts GLM-5.2 at 62.9% resolved, $1.40/problem and 5.52M tokens; GPT-5.6 Sol at 62.3%, $0.85 and 605k; Sonnet 5 at 56.8%, $1.43 and 4.65M; and MiniMax M3 at 47.2%, $0.95 and 13.87M. This disagreement with Vals is useful: model order, token use and cost depend heavily on harness, task set, reasoning settings and stopping behavior. Source: [SWE-rebench](https://swe-rebench.com/).

The Qwen3.8-Flash-Next card reports, under its own Claude Code/mini-SWE-agent evaluations, DeepSWE 1.1 58.7, SWE-bench Pro 62.5, Toolathlon Verified 73.5, LiveCodeBench v6 91.9, OSWorld 2.0 binary 19.4/partial 52.3 and Vision2Web 64.0. It is evidence for tool use and visual/UI work as well as coding, but it is not a directly comparable Go score. Source: [Qwen3.8-Flash-Next model card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8).

Official/community model cards provide additional anchors: DeepSeek V4 Pro reports SWE-bench Verified 80.6 and SWE-bench Pro 55.4; MiniMax M3 reports SWE-bench Verified 80.5 and SWE-bench Pro 59.0 (the card notes Claude Code scaffolding and four-run averages). The Kimi K3 numbers (DeepSWE 67.5, Terminal-Bench 2.1 88.3, Toolathlon-Verified 76.5 and OSWorld-Verified 84.8 at max reasoning) come from an **SSBOfficial Hugging Face card whose official Moonshot provenance was not independently confirmed**, so treat them as secondary until verified. These numbers come from different harnesses and dates, so they should be treated as capability bands, not a global leaderboard. Sources: [DeepSeek V4 Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro), [MiniMax M3](https://huggingface.co/MiniMaxAI/MiniMax-M3), [Kimi K3 (third-party card)](https://huggingface.co/SSBOfficial/Kimi-K3).

The Go page also publishes its own per-million-token accounting (the provider's allowance basis). For the Go plan on 2026-10-31: GLM-5.3 Flash is $0.15 input / $0.50 output / $0.03 cached read with a $60 monthly model allowance; GPT 6 Luna is $0.10 / $0.50 / $0.01 (or $0.20 / $0.75 / $0.02 above 272K tokens) with a $15 allowance; Qwen3.8 Flash is $0.15 / $0.47 / $0.016 with a $30 allowance; DeepSeek V4.1 Flash is $0.15 / $0.60 / $0.003 off-peak or $0.30 / $1.20 / $0.006 peak with a $100 allowance; DeepSeek V4 Pro is $0.66 / $1.98 / $0.022 off-peak or $1.32 / $3.96 / $0.044 peak with a $15 allowance; and Kimi K3 is $3 / $15 / $0.30 with a $15 allowance. These are provider usage limits, not LAZERS execution budgets.

OpenRouter's live catalog (queried 2026-10-31) is a separate API-equivalent reference, not a Go invoice or proof that Go uses the same snapshot. Selected current values, in USD per token, are: `openai/gpt-6-luna` input 1e-7, output 5e-7, cache read 1e-8; `z-ai/glm-5.3-flash` 1.63e-8/1.479e-7/1.63e-8; `deepseek/deepseek-v4.1-flash` 4.5e-8/5e-7/6e-9; `xiaomi/mimo-v2.6-flash` 1.4e-7/2.8e-7/2.8e-9; `minimax/minimax-m3.1-flash` 1.5e-7/6e-7/1.5e-8; `qwen/qwen3.8-flash` 1.5e-7/4.7e-7/1.6e-8; `moonshotai/kimi-k2.7-code` 6e-7/3.5e-6/1.5e-7; `z-ai/glm-5.3` 6.99e-8/1.4e-6/6.89e-8; `deepseek/deepseek-v4-pro-0813` 6.6e-7/1.98e-6/2.2e-8; `moonshotai/kimi-k3.1-pro` 2e-6/1e-5/2e-7; and `anthropic/claude-sonnet-5.5` 2e-6/1e-5/1e-7. Prices are volatile and aliases/snapshots differ. Source: [OpenRouter models API](https://openrouter.ai/api/v1/models), retrieved on the date above.

## Three implementor personas

These are routing labels, not extra agent identities. The task remains the source of truth; the persona adds only model selection and a small execution emphasis.

| Persona                      | Use for                                                                                                               | Starting Go candidates                                                                             | Evidence and caution                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Small task / refactoring** | One observable behavior, localized bug, migration, tests, cleanup, mechanical API change                              | GPT 6 Luna; GLM-5.3 Flash; DeepSeek V4.1 Flash; MiMo-V2.6-Flash                                    | Luna and GLM Flash have high Vals resolve scores at very low API-equivalent cost; GLM Flash was unusually slow in that run. Keep scope localized and require focused tests. Flash models need trajectory monitoring for loops.                                             |
| **Systems**                  | Cross-module behavior, persistence/concurrency, state machines, failures and recovery, unfamiliar repositories        | GLM-5.3; DeepSeek V4 Pro; Kimi K3; Qwen3.8 Max; Claude Sonnet only as an external-route comparator | GLM 5.3, DeepSeek V4 Pro and Kimi K3 have strong repository/agent scores, but source tables disagree by harness and snapshot. Prefer the model with the best recent LAZERS accepted-result rate, not a static rank.                                                        |
| **UI / visual integration**  | Component behavior, browser/desktop interaction, screenshot or visual acceptance, accessibility and theme integration | Qwen3.8 Flash/Max; Kimi K3; Claude Sonnet only if separately connected outside Go                  | Qwen's card exposes Vision2Web, OSWorld and multimodal tool scores; Kimi's card reports strong OSWorld/Toolathlon but is third-party provenance (see evidence note). Public UI scores are not a substitute for running the actual OpenCode panel and checking screenshots. |

Three routing rules follow from the evidence:

1. Use the smallest persona that can plausibly satisfy the task. Escalate after a concrete failure or a missing capability, preserving the prior trajectory.
2. Choose by expected accepted-result cost, not token price: include retries, failed attempts, architect and worker usage, cache hits, latency and human review time.
3. Keep the model catalog and route metadata current. Go allowances are not OpenRouter dollar prices; OpenRouter figures are only a normalized comparison signal.

## Task writing guidance for these models

Research converges on a short, information-complete task rather than a procedural script:

```text
Goal
What should change and why it matters.

Done when
Observable behavior, including material success and failure cases.

Boundaries
Relevant compatibility/scope limits and explicit exclusions.

Starting points
Focused files, APIs, examples, failing test or reproduction.

Implementation guidance
Only code-grounded reuse advice, pitfalls and a promising approach. Mark advice as guidance; do not turn it into mandatory line-by-line steps.

Verification
Tests or runtime checks that prove the behavior.
```

The guidance section is where the Architect's stronger investigation pays off. A useful mini-skill has three parts: **reuse** (the existing abstraction to extend), **pitfall** (a repository-specific failure mode and why it matters), and **pattern** (a nearby implementation or small example). It should be omitted when investigation finds nothing material. The worker should still inspect the repository and use its judgment.

RealSWE finds that realistic requests are usually short and underspecified, while explicitly stating desired behavior and motivation improves coding-agent performance. SWE-agent shows that tool/interface feedback materially affects performance, so compact actionable tool output is more valuable than a longer system prompt. Agentless demonstrates a cost-effective localize → repair → validate pipeline. Clarification research finds that asking about missing behavior, reproduction, constraints and acceptance tests is more useful than adding generic instructions. Sources: [RealSWE](https://arxiv.org/abs/2608.27831), [SWE-agent](https://arxiv.org/abs/2405.15793), [Agentless](https://arxiv.org/abs/2407.01489), [Asking What Matters](https://openreview.net/pdf/80d74f4422da59712c5e5c807ef0d6cfce5d7a45.pdf).

Do not put these in every task: generic tool tutorials, repository-wide policy, speculative architecture, exhaustive file lists, arbitrary token/time limits, or a prescribed edit sequence. If a task needs that much text, first ask whether it is actually multiple independently verifiable outcomes or whether one compatibility decision genuinely requires an opinionated design.

## LAZERS dogfood matrix

Run the same small set of accepted repository tasks through Go models in Desktop, without paid OpenRouter calls. Keep task wording and acceptance checks fixed; vary only model/persona/reasoning setting. Start with one task per cell, then repeat failures and one success to measure variance.

| Task shape                                      | First model         | Comparator                                | What to record                                                                           |
| ----------------------------------------------- | ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Localized refactor with tests                   | GPT 6 Luna          | GLM-5.3 Flash                             | First-pass acceptance, test repair count, wall time, input/output/reasoning/cache tokens |
| Persistence/concurrency change                  | GLM-5.3             | DeepSeek V4 Pro or Kimi K3                | Correctness under races/restarts, scope drift, review grade, total trajectory            |
| UI panel behavior with screenshot/runtime check | Qwen3.8 Flash       | Kimi K3 or Claude Sonnet (external route) | Visual acceptance, interaction errors, tool retries, screenshot review                   |
| Same task with a missing detail                 | Each selected model | —                                         | Whether it asks a useful clarification instead of inventing behavior                     |

Record native usage per attempt and the final accepted result. A normalized OpenRouter estimate is:

`uncached_input_tokens × prompt_price + cache_read_tokens × cache_price + billed_output_tokens × completion_price`.

Keep reasoning/output accounting explicit; if the provider's billing semantics are not known, report the formula and range instead of pretending to know a dollar total. Then report **cost per accepted result** as the sum of all attempts for accepted tasks, with failures and retries included. Also retain the actual Go subscription usage separately.

## Confidence and missing tests

High confidence: Go's documented provider/model IDs and allowance accounting; Vals/SWE-rebench methodology and their reported per-problem metrics; the DeepSeek and MiniMax card values; the OpenRouter catalog snapshot. Medium confidence: mapping a model family to a persona, because UI and systems performance is not represented by one SWE-bench percentage. Low confidence: the unverified third-party Kimi card, exact Go allowance consumption in LAZERS, token efficiency in this harness, model variance under our task renderer, and whether a static model route is cheaper per accepted result.

The next evidence should be native Desktop runs with fresh sessions, the concise task template, and the current implementor instructions. Do not use public benchmark scores as a gate. Use them to choose the first sample, then let LAZERS trajectory and acceptance data update routing.
