# Spike 031: authored plan title source contract

`PlanInput` accepts an optional `title` of at most 120 characters. The title is
source-authored data: validation and persistence preserve its text unchanged,
including surrounding whitespace. It is independent of the required operational
`objective`; no title is inferred or generated from objective prose.

The normal versioned plan body is the source of record. `RunnerStore.submit`
persists the parsed `PlanInput` in both `runner_plans.body` and revision 1 of
`runner_plan_revisions.body`. Omission stays omission: existing bodies are not
backfilled or rewritten to add a title. Replaying the same `requestID` and
validated content returns the existing receipt without changing its body or
revision; changing the title under that request ID remains a content conflict.

Consumers can treat the field as an optional concise plan label, with the full
objective remaining separate detail. The focused Tasks contract describes a
short authored plan label or quiet plan-reference fallback, with the objective
in Details (`design/task-panel/execution-list.json:13,28-42`). The current task
query remains a flat task-summary projection (`src/tasks/contract.ts:21-39`,
`src/tasks/read.ts:16-53`); this source-field increment does not implement a
shared plan projection or grouped Tasks UI. Future consumers must preserve the
legacy absence and use a plan-reference fallback rather than deriving a label
from the objective.

The implementation is intentionally limited to source-schema and persistence
compatibility. It adds no sidecar, migration, historical backfill, UI, or
generated summary.

## Independent review

Reviewed existing task `1532ce08-7aac-434f-a8e1-a92e5d7e3cb3`, accepted artifact
`307cc40f384f675e8d9c37483bbf8d62ff51f4ca`, in the host-created isolated
`plan-title-review` worktree against main baseline `c787af3`. The registered
`lazers_submit_plan` tool uses `PlanInput` both for native JSON Schema and
submission, so this is source-schema data rather than a UI-only field. No defect
requiring a source repair was found.

Independent focused checks passed **7 tests / 70 expectations**; full suite passed
**181 tests / 1,598 expectations** across 40 files; formatting, lint and typecheck
passed. This baseline includes the Repomix increment, not the separately retained
scheduler review, so these counts are not a model or implementation comparison.
Trajectory inspection confirmed recorded acceptance with incomplete native-history
coverage; no API-equivalent cost is inferred. Main integration and runtime
integration recording remain pending the active shared worker's safe boundary.
