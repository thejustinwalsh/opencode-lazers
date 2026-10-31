# Spike 030 — grouped Tasks list

**Question:** Can the native Tasks list show real sequential and parallel work without inferring edges from summary order or turning a DAG into a misleading tree?

**Increment:** Consume the existing scoped observation snapshot to group recorded plan rows, disclose only unambiguous fork/join blocks, and expose dependency references from the selected-task inspector.

**Scope:** Extend the existing Tasks panel and its tests only. Reuse the shared observation and task-reference APIs. Do not add scheduler policy, a second topology service, or a graph canvas.

**Acceptance:** Chain rows retain their admitted ordinal; diamonds and disjoint forks disclose branch rows once and return shared joins to the root lane; overlapping edges remain references. Planless or unavailable topology remains ungrouped. History is explicit, group counts show active/total scope, and disclosure preferences are independent from row selection and search.

**Verification:** `bun test src/tasks test/task-panel src/observability test/observability test/task-links`; `bun test`; `bun run verify`; `bun run build:gui`.

**Outcome:** Implementation checks cover chain, diamond, disjoint, overlap, off-page prerequisites, snapshot-boundary retries, and linked dependency selection. The shared observation response currently exposes an optional plan title but not `PlanInput.objective`; the panel uses the recorded title when present and a short actual plan-ID fallback. Integration review repaired the real b50-shaped fork with an external speech prerequisite on its root-lane assembly join, while retaining conservative rejection of extra edges into branch heads/interiors and nonlinear branches. The isolated native-menu test now uses the shipped Solid/Vite transform instead of a mirrored JSX runtime fake. Native Desktop/Terra observation remains pending and is documented separately.
