# Durable runner specification dogfood

## Question and boundary

Can the native Desktop Architect turn the runner request and material user decisions into a valid, persisted specification, while exposing integration errors honestly?

This pass specifies the runner and repairs the existing submission adapter. It does not implement or accept the runner.

## Native result

OpenCode 2.2.5 Desktop, Architect, connected OpenAI GPT-6.1 Sol High, session `ses_e6f007c15ffe1HH5nmeqvV4UEA` submitted task **`94298112-1c6c-44ba-87f6-a06533eafa59`**, revision 1, at `2026-10-31T08:42:24.718Z`, then retrieved it successfully. Exactly one normal-database row belongs to this session. The exported retrieval equals the SQLite envelope and passes the production schema.

The native optional Tasks tab displays that task in Session scope, with connected updates, visible Done when and all 15 criteria available. Details and Activity remain collapsed. [Desktop capture](../../../design/task-panel/runner-submitted.png).

All prompts used computer control of Desktop. No CLI/service model prompt or direct database insertion substituted for submission.

## Resolved product scope

- Versioned dependency graphs now; serial execution with one implementation worker per canonical project. Deterministic runtime admission/readiness, with Architect returning for decisions.
- Relational SQLite plan/task/dependency/attempt/evidence/decision/delivery links, XState lifecycle, isolated committed worktrees and exact artifact verification. No automatic origin merge.
- Reconcile proven host activity after restart. Uncertain effects block with evidence instead of being repeated.
- Project-wide overlap audits and bounded session reconciliation. Idle unarchived sessions retain ownership; archived/missing owners are flagged for explicit reassignment.
- Architect tools and minimal panel audit/actions share validated backend services. No force-accept or budget-reset authority.
- Flow/Timeline and parallel workers remain excluded. Connected subscription inference is allowed; no paid OpenRouter execution is authorized. Cost limits are equivalent API estimates.

The saved proposal is substantial: 15 assertions cover graph integrity, admission, audits, idempotent commands, authority, policy/budgets, combined artifacts, verification, real subprocess and isolated-host recovery, durable delivery, orphan handling, panel convergence and compatibility. This is a specification, not proof those capabilities are feasible or implemented. The implementation must establish exact public host behavior and report unsupported enforcement honestly.

## Observed failures and repairs

1. Submit/list returned structured output without declaring an output schema. The host rejected list results; the same mistake could discard a submit receipt after commit. The adapter now emits structured results only for get/query, which declare schemas.
2. A subsequent submit returned `Cannot use a closed database`. Retained tool callbacks can outlive their registration-scoped connection during reload. Each execution now acquires its own connection after permission assertion, executes synchronously and closes it. No uncertain write is retried. This lifecycle is covered by a regression that disposes the original connection and invokes retained submit/get/list/query callbacks, verifying exactly one saved task.

WAL and the existing 5000ms busy timeout remain enabled. Reopening before an operation and replaying a possibly committed operation are distinct. The runner still needs durable request receipts, transactional claims and fencing. A shared backend service should own database policy across native tools and GUI RPC; a single RPC transport is unnecessary.

The first turn also exhausted its 12-step budget after investigation, two material question rounds and tool failures. Continuations preserved the answered decisions. Neither the step limit nor the core Architect definition was tuned to this feature. Concurrent optional review guidance may change separately; this run does not evaluate that guidance.

## Checks and outcome

Five tool tests / 30 assertions pass, including output-schema compatibility, retained callback lifetime and permission denial. Full suite: **65 tests / 386 assertions**, all passing. Native formatter, linter and typechecker pass. No GUI source changed in this repair, so no new GUI build is claimed.

Retain the adapter repairs and runner specification. Before runner implementation, capture the actual source baseline: current HEAD is an initial commit and does not contain the untracked source. Preserve concurrent WebGPU work. Do not execute existing submitted backlog merely because records exist.

Task limits are 128,000 tokens, $150 equivalent API estimate, eight hours, 600 tool calls, one provider retry and one repair. These are proposed execution limits, not measured usage or authorization for paid inference. The native trial contains failures/continuations and is not a clean benchmark.

Evidence: [trial](../evidence/009-runner-dogfood/trial.json), [repairs](../evidence/009-runner-dogfood/adapter-repair.json), [initial trace](../evidence/009-runner-dogfood/before-repair-trace.json), [intermediate trace](../evidence/009-runner-dogfood/after-first-repair-trace.json), [successful trace](../evidence/009-runner-dogfood/success-trace.json), [saved envelope](../evidence/009-runner-dogfood/task.json). Focused traces omit private reasoning and provider-native blobs.
