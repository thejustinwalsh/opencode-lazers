# LLM work decomposition: useful work per dispatch

Targeted primary-source review, November7,2026. Read alongside the
[original mission](../../.agents/docs/sources/original-design-brief.md) and
[local task-boundary audit](task-boundaries-20261107.md).

## Decision

Use features as the default task unit. Architect groups work by shared context,
interfaces and useful completion; the worker plans its implementation steps.
Splitting must improve delivery enough to pay for repeated context, dispatch,
verification, review and integration. This is a planning judgment, not a new
admission gate, minimum diff size or numerical task quota.

## Papers and their limits

| Primary source                                                                                       | Relevant result and limitation                                                                                                                                                                                                                                                                                            | Application to LAZERS                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Co-Coder: When Parallelism Pays Off](https://arxiv.org/html/2606.00953v1), 2026 preprint            | Models partitioning as critical-path computation plus cross-agent context cost. Evaluates28 Python projects using gpt-5-mini; compares cohesive groups against sequential and file-based parallel approaches. Reported latency excludes testing. This is not a validated partitioner for our TypeScript maintenance work. | Group strongly coupled changes and changing interfaces under one implementor. Parallelize cohesive outcomes with usable upstream interfaces. Do not adopt its per-file internal scheduler nodes as user-facing LAZERS tasks.                                                        |
| [ADaPT](https://aclanthology.org/2024.findings-naacl.264.pdf), NAACL Findings2024                    | Decomposes as needed according to executor capability, rather than committing to a detailed plan before environmental discovery. Evaluated on ALFWorld, WebShop and TextCraft, not repository coding.                                                                                                                     | Avoid speculative micro-task trees. Research enough to establish the feature and acceptance, let the implementor choose routine steps, and adjust decomposition when observed difficulty warrants it. Do not require an avoidable failure before splitting a clearly large feature. |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3), 2026 revision     | Across260 configurations, coordination benefits depend on task/architecture alignment; tool-heavy and sequential work can suffer. Benchmark results are not a universal worker-count prescription.                                                                                                                        | Keep sequential work with shared context in one task. More agents are useful only when their work or expertise pays for coordination; do not maximize concurrency as a success metric.                                                                                              |
| [Runtime-Structured Task Decomposition](https://arxiv.org/html/2605.15425v1), 2026 workshop preprint | In two controlled workloads, selective retry reduces retry tokens, but normal successful execution costs more than monolithic execution. Ten runs per configuration; failure costs use simulated malformed inputs.                                                                                                        | Preserve useful results and repair the failed part with the existing worker. A retry-efficiency result does not justify adding normal-path stages to every simple change.                                                                                                           |
| [When Agents Coordinate](https://arxiv.org/html/2608.16801v1), 2026 preprint                         | Instruments messages and file activity across1902 runs plus a sealed confirmation study. Finds substantial communication effects. Uses two synthetic Python tasks and one pinned model; some shell activity is unobserved and channel token costs are proxies.                                                            | Reuse task context and repository findings instead of repeatedly onboarding agents. Track coordination separately from implementation. Neither a coordinator title nor more messages proves effective orchestration.                                                                |
| [LLM-as-Scheduler](https://aclanthology.org/2026.acl-long.581.pdf), ACL2026                          | Adaptive workflows avoid unnecessary fixed processing. Evaluation uses HumanEval, MBPP and GSM8K; reports output-token consumption and has domain-calibration limitations.                                                                                                                                                | Make verification proportional to the actual outcome and failure. Do not copy its learned gating design or skip required behavioral/live acceptance based on a confidence score.                                                                                                    |
| [LLMCompiler](https://proceedings.mlr.press/v235/kim24y.html), ICML2024                              | Separates dependency planning, ready-call dispatch and parallel execution to reduce sequential function-call overhead. Tool calls are not complete software delivery tasks.                                                                                                                                               | Architect decides useful work/dependencies; deterministic runtime dispatches ready work. Batch independent reads/tools inside an agent without turning each call into another worker/task lifecycle.                                                                                |

## Concise composition heuristic

1. Name the usable feature, repaired behavior or refactored responsibility.
2. Keep the changes and tests that jointly establish that outcome together,
   especially when they share source context or changing interfaces.
3. Split where independently useful outcomes, productive parallelism, distinct
   expertise or observed executor/context limits outweigh coordination cost.
4. Leave implementation steps and routine discoveries with the worker. Use
   existing scope revision and steering when needed; preserve useful work.
5. Verify the coherent result. Focused debugging checks are useful; repeated
   broad verification requires changed code or unresolved risk. Reuse applicable
   results and integrate prerequisites before dependent implementation.

For example, historical-task filtering and navigation to that task's trajectory
form one usable feature. A filter widget, query argument, renderer branch and
regression assertion are implementation steps, not four dispatches. Conversely,
a full scheduler and its whole dashboard roadmap can contain multiple useful
features; calling that entire roadmap one task would ignore executor limits.

## Application and observation

The packaged Architect now explicitly groups shared context/interfaces and
leaves internal implementation steps to workers. Existing feature-first guidance
and proportional verification remain concise. Detailed research stays here.

The live Architect inspected unstarted pairs170/171,148/149 and160/161 and
acknowledged the authorized consolidation into three end-to-end outcomes. That
acknowledgment is not proof of changed records or faster implementation; inspect
actual task/plan controls and subsequent worker results. Active180 and retained
172 work must continue, rather than restart to demonstrate the new guidance.

Judge improvement from request to integrated usable feature, including total
input/cache/output/reasoning tokens, market-equivalent cost, queue/implementation/
verification/integration time and human interventions. Count retained failures
and Root driver work. Compare compatible real work; neither fewer tickets nor
larger diffs demonstrates success. No paper establishes an optimal Luna task
size for this repository, and no claimed paper speedup is a LAZERS result.
