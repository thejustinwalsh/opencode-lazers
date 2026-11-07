# LZ-172 connected Desktop preview: current source variants

Candidate0d210a897dabc8a021ff68bca4d7fbd686d092e9 is clean and passed59task tests,
1507assertions, GUI build and quality checks. Root reviewed its readable labels
and route tooltip changes. It remained unintegrated for actual visual acceptance.

Root backed up canonical ignored GUI artifacts to
`/private/tmp/lz172-gui-preview-vzt9ofm_`, staged the candidate's already-built
`gui-experimental.cjs` and`radar-layout-worker.cjs`, then used native View→Reload.
This reload affects the renderer; the native service and worker sessions remained.
In the connected Models Compare panel with real LZ-137/Kimi data, the panel
rendered blank after initial loading. Renderer log20261107T194220 at
16:34:07.547EST recorded: `TypeError: Cannot read properties of undefined (reading 'sourceLink')`.

Candidate comparison-panel.tsx259 only handles `openrouter-endpoints` in
knownUsageSourcePresentation, based on its stale market-range.ts literal source
type. Current canonical market-range.ts94 emits three valid variants:
`openrouter-endpoints`, `openrouter-models`, `native-catalog`. The missing
presentation branch crashes on real current data. Endpoint-only test fixtures
and compiling against the worker's old producer type do not cover that contract.

Root restored both backed-up GUI files and reloaded only the renderer. The
previous Models chart and selected Kimi summary returned. No source integration,
visual pass, task completion or schema relaxation was recorded. The original
worker/candidate remain available; Architect received the actual error and current
producer findings for same-task repair and rendered-consumer coverage. Narrow/wide
and Terra visual acceptance remain open. The preview did not change model routes,
pricing settings, inference settings or production task data.
