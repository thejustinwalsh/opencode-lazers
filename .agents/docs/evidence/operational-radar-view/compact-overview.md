# Radar compact overview — implementation evidence

## Source and automated observations

- `src/radar/map-overview.test.ts` builds a scoped fixture with 35 native sessions. It verifies the initial ELK input contains only the scheduler, the current Architect when the active session is evidenced as `architect`, a task, and a worker with a recorded assignment edge. The active-worker count is derived from currently available busy worker sessions; missing task/model/route evidence stays explicit.
- The same test checks the overview layout fits within 310 CSS px (330 px viewport less 20 px inset), so it also fits the 450 px target without scaling text. It checks full scoped group counts, hidden session count, and the union of internal and original node/relationship identities in the disclosure model.
- A status-only busy/idle update retains the same measured ELK key and input geometry; `RadarLayoutCoordinator` performs no additional layout call and returns the same coordinates.
- `src/radar/presentation.test.ts` exercises delayed restoration for both scroll axes and confirms an obsolete scope's pending restore cannot change the new scope's position. Native `<details>`/`<summary>` controls and button-based record selection retain browser keyboard semantics; focus-visible and selected-state styling are in `src/radar/panel.css`.
- `src/radar/state.test.ts` and `src/observability/state.test.ts` exercise independent monotonic Radar/lifecycle reads, shared live-event high-water tracking, scope/generation rejection, drifting boundaries, and recovery to a common boundary. Existing Radar regressions continue to cover event gaps, reconnect quiet-baseline behavior, and evidence-only pulse deduplication.
- `bun run build:gui` bundled the ELK worker for the Desktop build. The build completed; Vite emitted existing `import.meta` CommonJS warnings for `onnxruntime-web`.

## Checks

- `bun test test/radar/map.test.ts src/radar/layout.test.ts src/radar/presentation.test.ts` — passed, 16 tests.
- `bun test src/radar test/radar test/observation-panels` — passed after building the expected ignored `dist/radar-layout-worker.cjs`, 31 tests.
- `bun test src/observability/state.test.ts` — passed, 1 test.
- `bun fmt`, `bun lint`, `bun check`, and `git diff --check` — passed.

## Native visual acceptance boundary

No scoped OpenCode Desktop capture or native interaction was performed for this change. The repository's controlled product-verification path requires explicit trial authorization and an available native Desktop interaction surface; neither was established in this implementation session. Consequently, these checks establish compact model/layout geometry and source-level interaction affordances, not actual rendered 330–450 CSS px readability, accessibility behavior, or overflow in Desktop. A native observation should confirm the initial scheduler/Architect/worker view, expand and select a counted record into the lower inspector, and verify the retained viewport after refresh before visual acceptance.
