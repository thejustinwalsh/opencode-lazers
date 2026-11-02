# Operational Radar Desktop review

Partial native observation, 2026-11-02 UTC. Original LZ-34 acceptance remains open.

Canonical `bun run build:gui` exposed a real main-process failure in Settings →
Extensions → Plugins: `__dirname is not defined`. OpenCode 2.2.5 evaluates GUI
bundles with `new Function("require", "module", "exports", code)`; it supplies no
bundle filename. The copied ELK adapter also relied on a runtime package lookup.
Root bundled ELK with its adapter, embedded the worker source in the GUI bundle,
and retained execution in a native worker thread. No service/location restart,
inference-setting change, or new implementation attempt was used for this repair.

The regression evaluates the main adapter with the host's three-argument ABI,
registers its IPC provider, and executes a real ELK layout in a worker thread.
Eight packaging/layout tests passed with 42 assertions; autoformat, lint and
typecheck passed. The rebuilt GUI was picked up automatically by Desktop. Its
plugin failure disappeared, the local model showed Ready, and the live Map
received layout geometry instead of reporting unavailable IPC.

The rendered result is not usable yet: the actual session graph has a
10,155 × 8,599 SVG canvas and 115 node elements, while the initial narrow viewport
shows mostly empty group outlines. These dimensions and elements were observed
through the native Elements inspector. The Console paste warning was not
bypassed; no console script or profiler was run. A retained scroll position was
checked with upward/leftward scrolling, without resolving the empty overview.
Screenshot: `/private/tmp/lazers-radar-first-native-20261102.png`.

Tera 6.1 High reviewed the actual capture against the approved direction and
rejected visual acceptance. Its [correction plan](native-terra-review.md) calls
for a compact live overview with expandable groups rather than shrinking all
115 nodes into unreadable text. Readable initial overview, narrow/wide layout,
selection and lower inspector, managed/other-session scope, and a real correlated
dispatch, route, outcome and live update still need native verification. Existing local
inference settings remain enabled. Tests and main-handler activation do not
establish these remaining product outcomes.
