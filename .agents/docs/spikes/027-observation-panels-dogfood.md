# Radar and Trajectory native panel integration

## Spike record

- **Question:** Are the completed Radar and Trajectory observation views reachable
  from the shipped Desktop GUI entry without changing Tasks or local inference?
- **Increment:** Register both optional native side panels and their session-scoped
  view stores in the combined GUI entry; exercise that root setup and its native
  open paths in a regression test.
- **Scope:** `src/gui.tsx`, the combined `dist/gui-experimental.cjs` build, and
  `test/observation-panels/`. Existing projections/RPCs and independent panel
  implementations are retained. No scheduler, telemetry, speech, or GPU changes.
- **Acceptance:** Root setup exposes one closable Radar tab and one closable
  Trajectory tab, while preserving Tasks and the six enabled inference features.
  Production data and layout/lifecycle behavior must also be reviewed in Desktop
  on real scheduler work, with captures reviewed by Terra.
- **Execution:** Implementor model GPT-6 Luna; OpenCode CLI `v2.2.5`; Bun
  `1.4.4-canary.1` (`da867c60b`). Worktree started at
  `e7aae9618ad1f07563c02d82b7dddaa1936f1bf2`:
  `/Users/tjw/.local/share/opencode/plugins/lazers/runner/worktrees/0bd64a2f-c81d-4b61-b1b5-c6af0bf75a30`.
  The task-runner session ID and usage counters were not exposed here; costs are
  unknown. No native Desktop session was started by this implementor.
- **Outcome:** The combined GUI entry and root registration regression are
  implemented and the required automated checks pass. Root's native evidence and
  Terra review are recorded in main commit `ff4a717`; only the observed viewport
  and interactions are accepted, while the explicitly unobserved coverage
  remains unresolved. See
  [`evidence/027-observation-panels/native.md`](../evidence/027-observation-panels/native.md)
  and [`evidence/027-observation-panels/verification.md`](../evidence/027-observation-panels/verification.md).

## Integration notes

`src/gui.tsx` now declares the Radar and Trajectory session stores alongside the
existing Tasks store and calls each panel's setup from the same shipped GUI entry.
Each renderer remains owned by its panel module; the build emits one combined
bundle. The root test invokes that entry's setup and checks the registered panel
IDs, optional/closable tab lists, stores, and command/session-menu open targets.

The automated integration test does not run the native Desktop host. Existing
projection and panel-state tests exercise the production observation adapters
against repository-backed fixtures; those fixtures are not live scheduler work
and are not evidence for visual fidelity, Terra's review, or parallel native
worker execution.
