# Task history and navigation worker review

The implementation adds independent persisted Tasks scope and state filters,
keeps the legacy history preference and `includeCompleted` query contract, and
filters in both project and session-association queries before counts and keyset
pagination. Execution-state matching treats blocked and cancelled plan states as
effective task states. The selected task's UUID, LZ reference, and project identity
are staged before opening Trajectory; mounted history requests replace older
requests and do not fall back to another task.

## Legacy query compatibility repair

Unspecified `state` with omitted or false `includeCompleted` now preserves the
original query behavior: accepted, incorporated, and cancelled work is excluded,
while failed/exhausted work remains visible. This is distinct from explicit
`state: "open"`; `includeCompleted: true` still selects all states. Both project
and session-association tests verify exact legacy page unions/counts and cursor
continuity for omitted versus false, plus rejection when a legacy cursor is reused
with explicit `open`.

## Historical filter group presentation repair

Plan active/total fractions now render only for the Open filter, with the
existing accessible active-count name retained there. Completed and Cancelled
views omit those misleading fractions while preserving the plan title as the
accessible section name. The independent scope control now says only Session or
Project; the state control names the selected history filter. Rendered-component
tests exercise Open (1/2 shown), Completed (0/1 hidden), and Cancelled (1/1
hidden), including their accessible group names.

## Automated verification

- Focused task/history checks: 73 passed, 0 failed, 585 assertions.
- Full test suite: 383 passed, 0 failed, 3,599 assertions.
- `bun run verify`: formatting, lint, and strict TypeScript passed.
- `bun run build:gui`: passed; Vite emitted existing import-meta/deprecation
  warnings for the pinned GUI bundle.

## Native Desktop recheck remains outstanding

No fresh mounted Desktop interaction or screenshot was captured for this repair.
The supplied native review identified the misleading fractions; the rendered
component checks cover the correction but are not a substitute for a native
recheck at the target width. User/Root should confirm the updated group headings
and accessible names on the exact candidate before the native acceptance gate is
considered satisfied.
