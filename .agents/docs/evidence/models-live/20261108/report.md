# Live Models observation — 2026-11-08

Root used Computer Use on the existing main OpenCode Desktop, session
ses_e568438ebffeaoFbF9nBb942XM. This is live project data, not a fixture. No model
route, effort, assignment or price-source setting was changed; no inference was
requested by these checks. Main Architect and its worker continued separately.

## Observed behavior

Compare initially displayed Loading, then rendered a chart with Kimi K3.1 Pro
high and Qwen3.8 Flash medium. A single selected-model inspector sits below it;
the persistent side-by-side table is absent. Details are collapsed. Current
selected task was LZ-137. Plot labels remain crowded at the current narrow width.
This observation does not establish faithful mockup matching or all chart states.

Sources showed native catalog472records, OpenRouter425records and external coding
benchmarks152records, fetched at23:39:54–55UTC. Native read-only RPC confirmed
ordered prices OpenRouter→OpenCode; both source connections are configured.

Read-only resolution against those stored snapshots returned exact matches:

| Execution route             | OpenRouter product          |
| --------------------------- | --------------------------- |
| opencode-go/qwen3.8-flash   | qwen/qwen3.8-flash          |
| opencode-go/kimi-k3.1-pro   | moonshotai/kimi-k3.1-pro    |
| openai/gpt-6-luna           | openai/gpt-6-luna           |
| openai/gpt-6.1-sol          | openai/gpt-6.1-sol          |
| anthropic/claude-haiku-5-5  | anthropic/claude-haiku-5.5  |
| anthropic/claude-sonnet-5-5 | anthropic/claude-sonnet-5.5 |

The two plotted routes use OpenCode prices. Their OpenRouter model records have
prompt/completion/cache-read prices but null cache-write prices. The current
whole-model applicability rule rejects a source when a required usage category
lacks a quote unless that category is observed zero. This explains the fallback;
it is not an identity-match failure. No missing price was replaced with zero.

The overview produced at23:42:03.278UTC reported current/partial availability,
95classified and97unclassified tasks,192total, and two chart configurations. Both
had one accepted task. These are the current projection's results, not proof that
only two project tasks are complete. Reconciliation of other accepted work,
conditional OpenAI tiers, attribution and plotted coverage remains unproven.

Assignments showed UI, Systems and Small task/refactoring each mapped from the
project to openai/gpt-6-luna/max. Opening UI exposed the target selector, native
model picker, effort and manual-route controls. The native picker listed OpenAI,
Anthropic, OpenRouter, Go and other configured routes. It was closed without a
selection or save; persistence/dispatch after an edited assignment was not tested.

UX finding: opening the project-derived UI row defaulted the editor to Task
override because the Compare view had retained LZ-137. It showed an empty override
rather than the effective project route. Clarify edit scope/defaults in existing
Models work; do not silently change a task while the user intends project setup.

## Artifacts and limits

- [Live comparison](compare.png)
- [Assignment editor](assignments.png)

Root performed the navigation and native RPC/source reads. Price refresh was
initiated by the panel's normal source-loading flow. Loading duration was not
instrumented. No assignment mutation, click on a different chart point, full
scroll/narrow-layout audit, or isolated real-worker run is claimed. Architect
should map these observations to existing acceptance requirements and keep any
unproven clauses open.
