# Authorized narrow Root corrections

The user chose **Root fixes** rather than waiting for LZ-57 same-attempt repair.
Both tasks are already accepted; ordinary Resume cannot reopen them. Preserve the
original attempts, sessions, routes, source and history. No new retry tasks,
replacement workers, successful product-probe replay or forced acceptance.

## Radar first — retained candidate `997c84c`

Tree: `~/.local/share/opencode/plugins/lazers/runner/worktrees/99b10b5a-ddf3-4cc9-83bb-c9d2a4d7d460`.

1. `src/radar/state.ts:182–189,263–272`: recovery readiness is set but not
   invalidated when the shared high-water mark overtakes its Radar baseline.
   Add a pulse-sensitive regression for quiet Radar103/lifecycle103 recovery,
   then Radar103/lifecycle105, then contiguous change106 and Radar106. Previously
   unseen catch-up evidence104/105 must not pulse. Preserve useful independent
   projection publication, generation/scope/order fences and later fresh pulses.
2. `src/radar/map-overview.ts:321` returns `graphEdges: []`; the test explicitly
   requires the empty graph. Restore a bounded set of existing typed relationships
   in the SVG and their evidence-only pulses, retaining relationship buttons,
   complete counted disclosure and readable narrow geometry. Do not invent edges
   or restore an all-history canvas. Active-worker priority and stable-ID/reactive
   connection-button focus are cleared and should remain intact.

Independent retained checks: 33 tests/257 assertions and fmt/lint/check/diff pass.
Those passes do not resolve these two source findings. Preserve C4 SVG/ELK,
embedded worker packaging, native theme and lower inspector.

## Relay — retained candidate `b164643`

Tree: `~/.local/share/opencode/plugins/lazers/runner/worktrees/ad12b78c-f5ec-43e8-ad16-d46aefc39eb4`.

`src/webgpu/relay/desktop.ts:465` checks only abort state; `location.ts:136–147`
also accepts completion without checking its clock. Enforce the original absolute
deadline when accepting results, even if timer callbacks are delayed. A
discriminating injected-clock regression starts at10000, incurs250ms handoff,
advances to11001 inside the renderer callback and then returns success: it must
not succeed. The current late-result fixture first waits for timeout rejection
and misses this race. Preserve valid1000ms requests, pre-delivery-only capacity
reclamation, delivered-work uncertainty and non-blocking discovery. No timeout
inflation, inference replay, credential handling or healthy-service restart.

Independent retained checks: 29 tests/185 assertions and quality pass. Capacity
and event-consumption corrections are source-cleared; this deadline race is not.

## Return and activation

Return exact focused commits and red/green regression evidence for independent
review before merging. Preserve every intervening Root/LZ65 change. Coordinate
driving GUI build/automatic pickup; actual candidate narrow/wide captures and the
already-requested Tera High follow-up remain required. Native enabled non-default
review/cold-start proof remains separate for relay. No inference flags, profiler,
service restart, broad location reload or automatic cleanup of retained trees.
