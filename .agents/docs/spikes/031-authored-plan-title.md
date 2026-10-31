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
