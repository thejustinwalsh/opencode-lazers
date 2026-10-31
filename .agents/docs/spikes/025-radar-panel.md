# Radar Flow and Timeline

## Spike record

- **Question:** Can a native, optional Radar panel show the real versioned task
  state machine and record-backed history without inventing current state or
  elapsed time?
- **Increment:** Register a closable native Radar panel with Flow and Timeline
  views, a resizable visualization/detail split, and scoped live observation.
- **Scope:** `src/radar/**` and focused Radar tests, plus this record. Shared GUI
  entry wiring, trajectory review/statistics, runner changes, and GPU work are
  excluded.
- **Acceptance:** Flow derives its nodes and directed event edges from the
  observability machine definition and highlights only a matching persisted
  snapshot. Timeline uses recorded transitions, attempt reservation starts,
  worker execution endpoints, and verification-receipt endpoints on one time
  axis. Missing endpoints remain unknown; open execution spans extend only to a
  fresh connected observation whose persisted machine state confirms activity.
  Scope changes, duplicates, event gaps, reconnects, and late RPC responses do
  not mix observations. The panel uses native theme/fonts, independent scrolling,
  pointer and keyboard split resizing, and persisted view preferences.

## Implementation notes

`src/radar/registration.ts` owns the optional closable side-tab and its command
and session-menu entry points. `src/radar/panel.tsx` owns the Solid view and
scoped preferences; it is intentionally not wired into `src/gui.tsx` in this
increment. `src/radar/state.ts` uses `ObservationSyncState` to invalidate and
resnapshot observations, reject stale generations, retain a stale last snapshot,
and retry a closed stream. `src/radar/transport.ts` keeps native RPC location
and event details at the adapter boundary. The native project ID is distinct from
the canonical directory: the ID fences observation responses, while the
canonical path keys preferences and locates RPC requests.

Flow is an SVG statechart with actual state nodes, directed event-labelled
edges, a separate recorded/traversed treatment, and an accessible state/edge
list. A current highlight requires the supported machine version and a persisted
snapshot matching the recorded node state. A long forward edge routes around
intermediate nodes rather than crossing them. Task dependencies are not used as
machine edges.

Timeline uses shared x-axis positions for attempt, execution, check, and
transition lanes. It consumes the additive snapshot `attempts` and `checks`
metadata when present (as reviewed in driver commit
`bf5a8b0af8286e6ecde4cd5093edc528f0386e10`); those fields are optional at this
baseline, so absent metadata does not fabricate lanes. Execution and check
endpoints come from recorded worker events and verification receipts. A stale or
disconnected snapshot does not extend an open execution span. Rich trajectory
reads are not fetched per lane.

## Verification

Recorded after implementation on 2026-10-31; source and adapter behavior only.
These checks do not establish native visual acceptance:

- Focused: `bun test src/radar test/radar src/observability test/observability` —
  22 pass, 0 fail, 153 assertions.
- Full: `bun test` — 238 pass, 0 fail, 2,299 assertions.
- Quality: `bun run verify` — formatting, lint, and type checking passed.

## Native review boundary

The production native registration and real RPC/state adapters have focused
coverage, but the shared GUI entry is not wired here. No Desktop screenshots or
Terra visual review are claimed; root assembly owns the narrow/wide native
captures and final visual acceptance.
