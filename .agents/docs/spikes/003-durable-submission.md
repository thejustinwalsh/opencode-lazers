# 003 — Durable task submission

Question: Can a native agent submit and retrieve validated tasks across plugin restarts?

Increment: Plugin-owned SQLite database, project/session provenance, and schema-bound submit/get/list tools. Submitted means recorded; execution remains out of scope.

Scope: Extend retained spikes 001–002 on unborn `main`. Write storage/submission modules and tests, plugin adapter, dependency metadata as needed, and relevant docs. Exclude workers, graphs, admission, scheduling, and custom GUI.

Acceptance: Invalid submissions save nothing and return field-level guidance. Valid submissions return a durable UUID. Reopening SQLite preserves the task. Project boundaries and shared worktree identity are explicit. Native host loads the adapter; Desktop acceptance remains pending the user's interactive test.

Execution: One Codex worker using Bun SQLite, Zod, Effect, pinned host definitions, and portless-dev-servers for network verification. No provider calls.

Budget: 30 minutes, 60 tool calls, 20,000 generated tokens, $0 provider spend, one repair attempt.

Verification: Frozen install, native quality checks, tests for validation/persistence/reopening/project isolation/submission behavior, and a bounded actual-host compatibility probe. Do not treat CLI loading as Desktop acceptance.

Outcome: Retain the implementation. Twelve behavior tests (56 assertions) and native quality checks pass with zero warnings. Reopening preserves submissions; invalid input does not collect provenance or write rows; canonical project isolation is tested. The existing isolated OpenCode 2.2.5 host reloaded successfully, reported `lazers` active, and logged the plugin-owned SQLite path. No provider calls. Desktop tool behavior and interactive permission denial remain pending user verification; CLI compatibility is not Desktop acceptance.
