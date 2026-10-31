# 002 — First task contract

Question: Can one task express executable intent and evidence without admitting incomplete proposals?

Increment: A strict Zod proposal schema, generated JSON Schema, and a submitted-task envelope with runtime-owned identity/provenance. Submission does not admit or start execution.

Scope: Unborn `main`, following retained spike 001. Write task schema/tests, pinned Zod dependency/lockfile, and relevant docs. No graph, executor, persistence, or host tool in this increment.

Acceptance: A complete proposal validates. Missing fields, unresolved questions, escaping write paths, duplicate identifiers, and broken evidence references fail. JSON Schema is generated from the same Zod schema. Provenance supports an unborn repository explicitly.

Execution: One Codex worker, Bun/Zod and repository instructions. No delegation or provider calls.

Budget: 20 minutes, 35 tool calls, 15,000 generated tokens, $0 provider spend, one bounded repair.

Verification: Frozen install, native quality checks, and meaningful `bun test` contract tests. Changes to schema/tests/dependencies invalidate their evidence.

Outcome: Retain. Zod 4.6.7 is pinned. Six behavior tests pass (30 assertions), covering strict drafts, path boundaries, cross-field references, explicit budgets, and unborn provenance. Frozen install, native formatting, lint (zero warnings), and typechecking pass. One bounded cleanup removed lint warnings. No provider spend. The generated JSON Schema carries structural constraints; Zod additionally checks cross-field references. Budgets are task requirements only until execution policy exists.
