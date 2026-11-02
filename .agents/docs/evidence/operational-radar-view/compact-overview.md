# Radar compact overview — implementation evidence

## Source and automated observations

- `src/radar/map-overview.test.ts` builds a scoped fixture with 35 native sessions. A newer idle/succeeded attempt competes with two busy workers whose attempts are running; the test verifies the active workers win the bounded selection alongside the scheduler, evidenced current Architect and task. The compact ELK node overview fits within 310 CSS px (330 px viewport less 20 px inset), so it also fits the 450 px target without scaling text.
- The focused connection rows expose both selected task assignments and supported prompt/outcome relationships. Their directed endpoints, kinds and statuses remain available through stable-ID buttons and the full counted disclosure; the narrow node layout does not arbitrarily select a single representative edge. Missing task/model/route evidence stays explicit.
- The overview test checks full scoped group counts, hidden session count, and the union of internal and original node/relationship identities. A Solid `mapArray` regression confirms a focused connection row keeps identity across refreshed records while its reactive lookup returns the updated relationship.
- A status-only busy/idle update retains the same measured ELK key and input geometry; `RadarLayoutCoordinator` performs no additional layout call and returns the same coordinates.
- `src/radar/presentation.test.ts` exercises delayed restoration for both scroll axes and confirms an obsolete scope's pending restore cannot change the new scope's position. Native `<details>`/`<summary>` controls and button-based record selection retain browser keyboard semantics; focus-visible and selected-state styling are in `src/radar/panel.css`.
- `src/radar/state.test.ts` and `src/observability/state.test.ts` exercise independent monotonic Radar/lifecycle reads, shared live-event high-water tracking, scope/generation rejection, drifting boundaries, and recovery. The added delayed gap/catch-up regression verifies baseline 100 → gap 103 → Radar 101 → Radar 103 stays quiet, with only subsequent contiguous activity eligible to pulse.
- `bun run build:gui` bundled the ELK worker for the Desktop build. The build completed; Vite emitted existing `import.meta` CommonJS warnings for `onnxruntime-web`.

## Checks

- `bun test test/radar/map.test.ts src/radar/layout.test.ts src/radar/presentation.test.ts` — passed, 16 tests.
- `bun test src/radar test/radar test/observation-panels` — passed, 33 tests.
- `bun test src/radar/state.test.ts src/radar/map-overview.test.ts` — passed, 8 tests, including recovery-fence, worker-priority, compact-geometry, connection-selection and stable-key regressions.
- `bun test src/observability/state.test.ts` — passed, 1 test.
- `bun fmt`, `bun lint`, `bun check`, and `git diff --check` — passed.

## Native visual acceptance boundary

No scoped OpenCode Desktop capture or native interaction was performed for this change; the narrow/wide Desktop observations and Tera High follow-up remain pending. The repository's controlled product-verification path requires explicit trial authorization and an available native Desktop interaction surface; neither was established in this implementation session. The initial implementation's `bun run build:gui` packaging check was not repeated for these source-review corrections, and no GUI was built or activated here. Consequently, the current checks establish compact model/layout geometry and source-level interaction affordances, not actual rendered 330–450 CSS px readability, accessibility behavior, or overflow in Desktop. A native observation should confirm the initial scheduler/Architect/worker view, expand and select a counted record into the lower inspector, and verify the retained viewport after refresh before visual acceptance.
