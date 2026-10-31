# Spike 026 — native Trajectory review panel

## Task record

- **Task:** `f1b1a687-31b7-4edb-a6bc-1865f61e0bdd`, revision 1.
- **Question:** Can the approved Trajectory review be presented as an optional,
  native side panel using the existing scoped observation projection, while
  keeping recorded attempt timing and incomplete token/cost data honest?
- **Increment:** Add a standalone Trajectory panel registration, projection
  adapter and state model with focused tests. The shared GUI entry is assembled
  separately.
- **Starting revision:** `bb2c78d0dcb9d0aff659096774659b443206a443`.
- **Write scope:** `src/trajectory-panel/**`, `test/trajectory-panel/**`, and
  this spike.
- **Exclusions:** Backend accounting/projection, Radar FSM rendering, shared
  GUI-entry wiring, GPU work, and live driver/Terra dogfood.

## Result

The standalone native panel consumes scoped snapshots and reads rich trajectory
details only for the selected task. Its upper timeline uses runner-recorded
attempt reservations, worker execution endpoints and receipt-backed check times
with a shared first-attempt origin; absent endpoints stay unknown rather than
being inferred from worker idle or task completion. Plan checks are associated
through all snapshot plans containing the selected task, while task-linked checks
remain visible and unrelated or unscoped legacy plan checks do not leak into the
timeline.

The lower resizable inspector follows selected attempts, checks and events, and
links to worker sessions and source locations. Token totals remain task-wide and
all-attempt, count unique sessions, distinguish known subtotals from incomplete
totals, and preserve unknown API-equivalent cost. Activity and payload details
start closed. The panel registration is exported but is intentionally not wired
into the shared GUI entry in this increment.

## Assembly boundary

This isolated worktree is based on `bb2c78d`, whose shared
`Observability.SnapshotOutput` predates the additive top-level `attempts` and
`checks` fields in driver review commit `bf5a8b0`. The panel adapter accepts both
snapshot shapes and consumes the canonical fields when present, but the shared
RPC output schema is strict. Root assembly must carry the canonical contract and
projection together before native use; do not solve this boundary by adding
backend changes to the panel increment.

## Verification

- `bun test src/trajectory-panel test/trajectory-panel src/observability test/observability`
  — 19 passed, 0 failed, 112 assertions. This includes the P1 multi-plan check
  association regression and null/missing legacy plan-ID exclusions.
- `bun test` — 235 passed, 0 failed, 2,258 assertions.
- `bun run verify` — formatting, lint, and strict typecheck passed.
- No live Desktop/Terra visual acceptance is claimed; assembly and dogfood remain
  separate.
