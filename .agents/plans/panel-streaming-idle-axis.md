# Full-scope panel streaming and shared idle-axis compression

## Product outcome

Implement DESIGN.md's full-result contract in Tasks, Radar, Trajectory and Models:
return real database pages, publish the first page promptly, automatically
continue to exhaustion for the current scope/filter, reconcile live updates, and
keep rendering bounded where large collections make interaction expensive.
Trajectory additionally compresses long **known idle** intervals on one shared
axis while retaining real timestamps/durations and distinct recording gaps.

This is new acquisition/visualization work, not a replay of the landed Tasks
virtualizer. Reuse existing LZ-216 for immediate project-wide multi-state filters;
do not duplicate or expand its selection/persistence/query-union scope.

## Grounded starting findings

Source research at66070762904cd9b7787640d6ad175a2d66e93701 found:

- Tasks already uses real SQL task pages and TanStack virtualization, but loads
  later pages near the viewport, waits for optional topology/scheduling before
  first publication, and refreshes a prior loaded extent. Activity hydration is
  separately bounded and must not be advertised as complete just because all
  task identities arrived. See src/tasks/panel-state.ts and
  src/observability/task-reads.ts.
- Radar overview has no cursor and whole-result session/activity limits. Selected
  history has real SQL keyset pages but manual continuation. Refresh-head and
  drain-tail positions need independent ownership. Include Diagnostics, not only
  the default monitor. See src/observability/live-{read,store}.ts and
  src/radar/monitor-{state,view}.ts(x).
- Trajectory's selected history first captures a bounded whole projection, then
  slices cached arrays. Broad choices and native-context availability have
  independent limits. Following existing cursors alone is not database streaming.
  See src/trajectory/history.ts, src/trajectory/read.ts,
  src/observability/read.ts and src/trajectory-panel/panel-state.ts.
- Models has separately paged candidates, decision rows/configurations and
  contributors, but the task picker reads one page and other producers materialize
  full projections before slicing. Decision progress's512-row SQL keyset scanner
  is a reuse point. Global financial statistics must not become page-local.
  See src/models/comparison-{state,read}.ts, decision-read.ts and
  observation-ledger-read.ts.
- Trajectory currently positions attempts/checks/tool/gap marks through linear
  timestamp ratios in projection.ts, tracks.ts, panel-layout.ts and panel.tsx.
  Every track, ruler, hit target and scroll/zoom calculation must use the same
  transform; changing only bar positions would misrepresent time relationships.

These are starting facts for independent audit, not a completed audit or a claim
that native telemetry/transcripts are complete. The older Repomix snapshot is
as-of-refresh; current Git/live source is authoritative for changed paths.

## Contract and coverage audit

Auditor first audits the intertwined producer/transport/controller/rendering
boundaries and publishes a source-grounded report at
`.agents/docs/panel-streaming-contract-audit.md`. This increment does not change
product source or take over active Tasks/filter writers. Enumerate all visible
collections, true SQL pages versus cached-array slicing, whole-result limits,
scope/cursor identities, live update races, rendering bounds, coverage and gaps.
Trace idle-axis coverage/placement callers and distinguish recorded idle from
unobserved or unloaded history. Group findings by shared cause/change boundary,
not one task per analyzer finding.

The report must independently confirm or correct the starting findings, explain
ownership of shared observability contracts, and identify focused behavioral
checks for each feature below. Architect retains task boundaries and sequencing;
concrete findings can refine this plan before implementation tasks are submitted.

### Reviewed integration baseline

Auditor's corrected report92b0a75 is retained with its original8efd10b source
boundary and Architect integration notes in the report. Its major first-page,
capture-slicing, cursor, coverage and renderer findings were independently
reviewed. Tasks does await optional topology and scheduling before publishing;
Models candidates/decisions/contributors slice full retained projections rather
than returning database pages. Radar Diagnostics remains included. All large
collections, including Models, need bounded mounted rendering where expensive.

Main98b1d85 already includes Opus6ec0e64/98b1d85 for independent Radar history
head/tail ownership and fresh-row merging. Exact quality,20focused tests, GUI
build and source review passed. Future Radar work must build on those fixes,
not implement them again. Current native regular-Desktop observations remain
separate from those automated/source checks.

### Shared delivery contract

Each collection publishes page one independently of later pages and optional
enrichment, then owns one cancellable background drain to genuine exhaustion.
Opaque cursors bind scope/filter/order and baseline identity; failed-page retry
can reuse its cursor, whereas repeated/cyclic advancement must stop. Live
upserts/removals cannot be overwritten by older baseline pages. Invalidation
restarts only the affected chain and retains useful visible data and identity
where compatible. Initial loading, background loading, exhausted, stale and
failed-page states remain distinct. New-view changes fence late responses;
same-view updates preserve focus, selection and anchors.

Keep per-page payload limits and telemetry/privacy coverage explicit. Do not
substitute a total-result cap for complete authorized browsable membership or
make global analytics page-local. The idle feature includes the missing
coverage/span producer as well as the shared transform and positive compression
behavior; no waiver or renderer-only substitute satisfies it.

## Tasks full-scope streaming

After LZ-216 source integration, one feature worker owns the Tasks producer and
consumer changes needed for prompt first-page publication and cancellable
background drain to exhaustion. Optional topology, scheduling and activity
enrichment must not block useful first rows or imply unsupported completeness.
Preserve its existing virtualizer, icon language, anchors, accessible logical
navigation, immediate filter semantics and independent inspector scroll.

## Radar complete live collections

One feature worker owns pageable authorized overview inventory/activity and
selected history, incremental first-page rendering, automatic continuation,
head/tail live reconciliation and large-list rendering, including Diagnostics.
Keep compact summaries distinct from the complete browsable collections; retain
explicit unavailable native coverage rather than inventing telemetry.

Concrete live-interaction coverage includes a head tick while page three is
in flight, followed by exhaustion without repeated pages or cursor rewind.
Retain the landed head/tail repair rather than reopening its old implementation.
A selected session temporarily absent from the newest inventory page must not
unmount a still-valid inspector or reset History expansion; an actual scope
change or authoritative invalidation clears that selection appropriately.

## Trajectory complete progressive history

One feature worker owns pageable task choices and selected history from actual
bounded database reads rather than whole-capture-before-first-page, progressive
track/activity rendering, complete continuation, live-event reconciliation and
large-list/mark rendering. Preserve privacy, event identities, selection and
honest native-context/recording gaps. Coordinate shared observability files after
Radar rather than creating competing producer writers.

Keep `workerProgress.truncated` and `recoveryGaps` visible in coverage even after
the acquisition cursor is exhausted: loaded-all and recorded-complete are not
synonyms. As earlier/later event pages extend `trackTimes`, preserve the selected
event/time and visual time/scroll anchor. Exercise these interactions at narrow
regular-Desktop widths after source integration.

## Models complete collections and truthful analytics

One feature worker owns full streaming of task choices, candidates, decisions,
configurations and selected contributors, plus source/data invalidation and
large-collection rendering. Decouple prompt rows from expensive global analytics
without publishing page-local frontier, counts or market-valued conclusions as
global facts. Preserve mapping/readback safety and existing ECharts adapters.
Consume LZ-216's final Tasks query identity; do not independently redesign it.

## Trajectory shared compressed idle axis

After progressive-history integration, one feature worker adds a monotonic
shared time transform with clearly marked compressed intervals across attempts,
checks, tools, file activity and the ruler. Compress only intervals established
as idle by available coverage; unloaded pages, unknown recording gaps, active
work and overlapping tracks must not be silently treated as idle. Inspectors
retain actual wall-clock timestamps and elapsed durations. All tracks, hit
testing, keyboard selection, zoom and scrolling stay aligned as pages/live data
change the domain. Deterministic visual policy belongs in one tested transform,
not independent per-track scale guesses.

This feature also owns necessary producer/coverage work: existing per-session
idle/model endpoints alone do not prove continuous cross-track idleness. Produce
trustworthy bounded coverage/idle intervals with recorded basis; absence of facts,
unavailable native context and unloaded history remain unknown. Do not fabricate
historical coverage. Verify a real positive known-idle interval compresses, not
just that uncertain fixtures remain linear.

## Integration order and combined acceptance

1. Review Auditor's report and settle common cursor/live-merge contracts.
2. Finish existing LZ-224 and LZ-216, then the preserved LZ-226 connected
   qualification. Per the user's later priority, new overlapping Tasks streaming
   waits for that qualification rather than competing with its walkthrough.
3. Radar and Models have separate feature lanes. Coordinate Radar's shared
   observation reader after existing LZ-139; Models follows the LZ-146
   presentation and LZ-216 query-interface integrations. Scope reservations still
   serialize other overlapping writers; they are not bypassed by these lanes.
4. Integrate Trajectory streaming after Radar's shared producer edits; then idle
   compression uses the resulting coverage/domain contract.
5. Architect composes retained commits, runs proportional combined checks and
   supplies each integrated revision for regular Desktop validation. Do not
   ship operator workflow as product UI or generic agent instructions.

Overlap coordination: retain LZ-216 filtering and LZ-224 heading outcomes before
the Tasks follow-up; coordinate existing LZ-139 observation-reader and LZ-146
Models presentation writers before those same files change. Preserve the
existing audit roadmap (including LZ-189), cancellation history and source
reservations. Runtime serializes conflicting scopes; an unavailable native
settlement or verification artifact is not solved by manufacturing acceptance.

Combined behavior checks cover first-page publication while a later page or
optional enrichment is blocked; exhaustion without scrolling/clicking; live
upserts/removals during draining; duplicate/cyclic/stale cursor protection;
scope/filter/server changes and cancellation; failure/retry with readable rows;
bounded mounted rows/marks; selected identity/anchors and independent scrolling.
Keep per-page payload safeguards but never label collection truncation as normal
exhaustion. Axis checks cover cross-track overlap, real gaps, partial coverage,
stable timestamp/position mapping and inverse hit testing where used. Use
`bun run verify`, focused registered RPC/component/axis tests and GUI build for
changed GUI code. Actual integrated regular-Desktop observations remain distinct
from component fixtures; no isolated trial is a prerequisite for this plan.
