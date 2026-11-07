# Radar agent monitor: delivery basis

## Outcome and boundaries

Deliver one coherent live agent-monitor feature through the existing Radar entry.
Reuse LZ-129's event-based bounded live read and separately progressive selected
history. Sessions lead; show actual task, model/effort, concurrent tools, grounded
file targets, observed messages and concrete health/wait facts. Default to managed
sessions inside the selected scope; details stay below a horizontal divider. C4
and state-machine maps are optional diagnostics, not the primary monitor.

This is independent consumer work where reservations permit. Preserve active
LZ-172 Models and LZ-182 Tasks. Keep the existing queued LZ-131 timing/receipt task;
do not dispatch its overlapping runtime/store work in parallel. Related consumer
fixes, integration wiring and tests belong to one Luna Max implementor, not small
producer/consumer microtasks. Final exact scope follows current-source research.

## Reconciled producer and older work

- Exact accepted producer `9f61a6633dd3d64a3bc51672c4e5d63e1234adcb` is in main.
  `lz129-9f61a6-source-review-20261106.md` and
  `lz129-canonical-integration-20261107.md` document the reviewed canonical
  reconciliation and passing checks; no new source merge was needed.
- Runtime now records LZ-129 integrated, with native removal of its owned worker
  worktree. Its source prerequisite is complete. This is not live monitor or
  whole-product CPU acceptance.
- LZ-62 and LZ-80 retain delivered overview/identity work with old native gates;
  LZ-34 and LZ-76 are cancelled. Reuse useful landed code and preserve histories;
  none is a queued implementation of the latest agent-monitor design.
- Historical Radar A/B notes are research, not automatic new task boundaries or
  proof a safe file-attribution producer exists. Current-source research must
  identify trustworthy fields and any necessary narrow seam; never infer a worker
  from a global file-change event or expose raw arguments/content as a fallback.

## Actual failing baseline supplied by Root

On 2026-11-07, while both original Models and Tasks native workers were running,
Radar Session **and** Project scopes failed even after native Refresh. The UI
showed `[object Object]`, “No operational Radar data is available,” and unavailable
details. Read-only SDK snapshot/radar calls returned `rpc.internal` / “RPC call
failed” in 154–230 ms. The server log at `2026-11-07T22:22:39Z` identified the
cause: **Observation scope is too large; narrow it.**

This is legacy broad-read failure, not absent workers or an empty result. Root's
committed baseline `f3e86de` is `radar-connected-baseline-20261107.md`, with screenshot
`artifacts/radar-connected-baseline/failed-project.png`. New live monitoring and
selected history must not depend on those legacy broad calls, inflated row limits,
new polling, native context loading or a second producer. Structured errors must
be useful public messages rather than object coercion; failures must not erase
valid rows or masquerade as empty/idle/healthy success.

The same actual baseline proves the existing producer works: Session `liveRadar`
returned one session/route in 73 ms (2390 bytes), and Project returned 12 managed
sessions, 50 routes, 126 calls and 233 flows in 189 ms (250319 bytes). Coverage was
explicitly bounded, with zero native context loads. These are returned-record
counts from single observations, not complete totals or performance targets.
Reuse this producer; no replacement producer is needed for the monitor.

## Native Terra High authoring guidance

Terra viewed `radar-agent-monitor-v2.png`, its review, `DESIGN.md` and the Astra
review. The approved image is a direction, not implemented/accepted native Radar.

- Thin scope/status header, then meaningful session activity before scrolling.
  Use compact two- or three-line narrow rows and aligned wide columns.
- Show concurrent calls independently, with trustworthy targets, lifecycle and
  labeled duration/age. Distinguish current from recent completed activity.
- Follow sessions with a compact observed event/message stream; selected session,
  call, file or event details stay below a resizable horizontal divider at all widths.
- Preserve focus, identity, selection and independent scroll through live updates.
  Keep diagnostics secondary and copy concise.
- Label visible counts and coverage without implying completeness. Missing data
  is not inactivity; do not invent targets, tokens/sec, progress or health causality.

## Acceptance and verification basis

Registered consumer tests should cover the actual entry and current live contract,
both scopes at retained-history volume, concurrent calls, exact session/task/route
identity, safe target/message handling, progressive selected history and useful
structured failures. Discriminating fixtures should make legacy broad methods fail
with the observed scope-limit error while the live monitor remains usable.
Exercise late results across scope/selection/reconnect/disposal, unchanged-event
identity, independent scroll, keyboard/divider behavior and explicit coverage.

Use normal automatic formatting/lint fixes via `bun run verify`, focused Radar
behavior tests and GUI build. Avoid active workers' shared Models/Tasks test files;
use dedicated registered Radar coverage. Root coordinates actual connected narrow,
wide and short-pane screenshots and interactions after delivery. Native Terra High
reviews the actual screenshots. No fixture/mockup-only visual acceptance or whole
CPU/battery improvement claim is authorized.
