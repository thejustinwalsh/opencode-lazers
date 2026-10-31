# Spike 013: readable task fetch

## Cause and correction

OpenCode 2.2.5 Code Mode evaluates a tool result by returning `output` whenever
it is defined; only otherwise does it join text content (with empty content
becoming `null`). The pinned host implementation is
[resultValue at 9bbb8ce](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/codemode/tool.ts#L314-L327).
Previously, `lazers_get_task` declared the structured `GetOutput` schema and the
implementor-specific formatter only changed `content`. Consequently Code Mode
returned the full object and ignored the readable prose.

The plugin now exposes `lazers_get_task_instructions`, whose declared output is
a string rendered by the existing `taskInstructions` function. The existing
`lazers_get_task` and `lazers_query_tasks` retain their typed task, execution,
and page outputs. Both paths keep permission checks ahead of repository reads,
use the same project/revision-aware `TaskReads`, and reopen a short-lived
repository connection per invocation. Runtime packets, worker prompts, and the
implementor role direct admitted workers to the readable path.

## Evidence

The registered-tool regression applies the pinned output-first `resultValue`
precedence and checks that the actual returned value is a string containing
the goal, done conditions, boundaries, advisory guidance, verification, and
sources. Additional tests cover structured access, missing tasks/revisions,
permission-before-read, project isolation, and callbacks retained after
registration disposal. Runtime tests check the worker prompt and persisted
packet select the readable tool.

On 2026-10-31, a native Code Mode smoke called
`lazers_get_task_instructions` for task
`8a2c9ed1-ff42-427f-9fb2-8583b1e81d97` and received a string with the Done when,
Implementation guidance (advisory), and Verification sections. A separate
`lazers_query_tasks` Code Mode call returned typed `projectDirectory`,
`snapshot`, and matching task status fields. No worker was spawned. Sanitized
observations are recorded in
[`evidence/013-readable-task-fetch/native-smoke.json`](../evidence/013-readable-task-fetch/native-smoke.json).

The Architect separately reported its live-tool smoke for this task: the
readable tool returned a string with Task, Done when, advisory guidance,
Verification, and Context references; `lazers_get_task` retained structured
task/execution data; and `lazers_query_tasks` returned typed page fields. This
provenance is recorded separately from the implementor-session calls. No host
reload was attempted; the Architect owns any supported idle reload and final
native review.

## Checks

Verification on 2026-10-31 passed: focused tests (34 tests / 349 assertions),
the full suite (139 tests / 1,029 assertions), and `bun run verify` (format,
lint, and strict typecheck). Native smoke observations do not replace these
checks.
