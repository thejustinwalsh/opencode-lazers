# Measured Radar read repair — 2026-11-04

Question: Which work makes the existing full Radar projection expensive, and can
we reduce it without changing its result or history window?
Increment: Optimize the existing query and short-text allocation. No schema,
settings, inference, history-retention, response-contract or UI-design changes.
Boundary: Same-snapshot output equality, focused regression coverage, type/lint/
bundle checks, followed by coordinated live activation and comparison.

## Attribution

The retained live project response was 8.65 MB. A read-only database snapshot
contains 30,994 progress rows / 61,249,822 payload bytes. Replaying actual
`ObservationReads.radar` against this fixed snapshot (native inventory stubbed
missing; no model calls) produces 8,545,040 bytes, 9,253 edges, 1,745 routes and
132 sessions. It is an isolated read-path benchmark, not service-wide CPU.

The initial six-read Bun CPU profile lasts 6.02 seconds: SQLite `all` is 59.8%
of samples; `safeText` is 14.6% inclusive; native `Array.from` is 6.4%. Query
instrumentation isolates the progress-history SQL at 3,217 ms over six reads.
Both the original and repaired queries still examine the applicable history.

Original EXPLAIN: progress index scan → plan-key lookup → correlated JSON
observation scan → temporary B-tree carrying full selected records. Repaired
EXPLAIN: materialize only seq/at/observed-at → sort narrow rows → fetch retained
records by integer primary key → final retained-window ordering. JSONB iteration
also avoids converting each observation object to text before extracting its
timestamp. A capability probe preserves `json_each` on older SQLite builds.
[SQLite documents JSONB iteration and its format](https://www.sqlite.org/json1.html).

Same-process interleaved actual-query comparison returns all 5,001 rows deeply
equal, in the same order. Excluding first cold runs, median query time changes
from 407.8 ms to 258.4 ms (about 37% lower). Full project projection equality
also passes; warm interleaved median changes from 734.4 ms to 567.2 ms (about
23% lower). Session scope is deeply equal at 8,142,941 bytes. These full-read
comparisons share the short-string optimization in both sides; separate initial
and final CPU profiles include both fixes. Final six-read profile lasts 4.28s;
`Array.from` falls to 2.2% of samples. Profile startup/JIT and machine workload
prevent treating these totals as a controlled service energy measurement.

Privacy still performs every redaction before the short-string fast path, and
counts Unicode code points when truncation may be necessary. The query retains
finite-number filtering, malformed-JSON handling, timestamp/sequence ties,
coalesced old-row recency, project/session scope and the existing 5,000-row
window plus overflow detection.

## Verification and remaining work

33 tests / 364 assertions pass across `src/observability` and
`src/trajectory/privacy.test.ts`. The command also named a nonexistent
`src/progress/projection.test.ts`; Bun skipped it, so it adds no coverage. Added coverage checks JSONB-unavailable fallback equivalence and
Unicode/redaction bounds. Bun native formatter, linter and typechecker pass;
isolated GUI build and process-free bundle smoke pass. Build retains its existing
ORT import.meta warning. Native production activation is pending coordination.

Artifacts under `/private/tmp`: `lazers-radar-query-comparison.json`,
`lazers-radar-equivalence-results.jsonl`, `lazers-radar-profile-before.json`,
`lazers-radar-profile-final.json`, `lazers-radar-before.cpuprofile.cpuprofile`,
`lazers-radar-final.cpuprofile.cpuprofile` and matching CPU-profile Markdown.
Snapshot data and raw response contents are not included in this report.

Root's separate renderer trace (`lazers-renderer-live-20261104T2057.json.gz`)
contains 4,104 document paints, 4,104 sidepane paints and 4,110 commits over its
36.117s recording. Those are separate event counts, not GPU utilization. Native
Main and two workers were active; Trajectory was selected and DevTools docked.
The trace has roughly 1.0s scripting versus 1.7s rendering / 1.7s painting in
DevTools' summary. It does not establish that Radar, local inference or a plugin
animation causes the paint cadence; no renderer CSS change is made here.

The full read still costs hundreds of milliseconds and transfers megabytes.
Radar currently requests it plus the lifecycle snapshot on accepted observation
changes, coalescing in-flight triggers and retrying mismatched boundaries. This
repair does not solve repeated historical reconstruction. The queued small live
projection/delta design remains the appropriate next architectural boundary.
Matched production read timings/process counters and actual event trigger rates
must precede any battery-improvement claim. Actual ORT MapAsync device-loss
failures remain a separate recovery investigation.

## Follow-up: bind event counters to their read location

A read-only native event observation at Unix1793831090311–1793831100315
received six canonical-location changes and the same six native changes from
each of three loaded worker locations: 24 envelopes in ten seconds. Their
independent counters differed (canonical sequence370 versus another location39).
Main and one native subagent were active. This is a measured trigger rate for
that work interval, not a steady idle rate or actual request-count measurement.

Both Radar and Trajectory had discarded `event.location` and passed independent
same-project counters to one synchronization state. A larger foreign counter
could cause a false gap and suppress later canonical changes; lower foreign
counters were discarded by the sequence guard. Both adapters now keep only the
location used by their scoped read methods. Missing locations are ignored.
Trajectory preserves native `server.connected` announcements and project checks;
Radar retains its synchronization state's project guard.

The focused follow-up passes 45 tests / 292 assertions across Radar transport/
state and `test/trajectory-panel`, including foreign high counters, missing
location, unrelated project, canonical continuation and reconnect. Native fmt,
lint, check and isolated GUI build/process-free smoke pass. A twelve-second
native-adapter smoke at1793831296414–1793831308416 observed one connection
announcement and no change events; it verifies connection handling but cannot
claim live changed-event filtering during that quiet interval. Production
activation and live verification remain coordinated by Root.

## Idle-service attribution capture (temporary)

The quiet native comparison after the query/transport rollout left service CPU unchanged (46.36% before, 46.37% after; same PID 95968). Renderer/GPU-process CPU was near zero. Those windows establish a separate persistent service cost; the read benchmark does not explain it.

A temporary `serviceCPUProfile` method on the existing typed Observability RPC captures the current Bun/JSC process for 10 seconds at a requested 1,000 μs interval. It requires the existing scoped read authorization and an Architect session. A process-global single-flight guard covers every plugin location, and request cancellation or registration disposal aborts the callback. `bun:jsc.profile` owns start/stop around that callback; no listener, controller, model-facing tool, permanent background timer, source body, prompt, or header is added. Returned data is function/file/line/category metadata and counted stacks. Actual elapsed time is recorded because a busy event loop can delay the timer. The capture itself adds diagnostic overhead and is not a baseline CPU measurement.

The route and helper are deliberately a separate commit to remove after attribution. Seven focused tests (65 assertions) cover authorization boundaries, disposed registration, concurrent capture refusal, cancellation/failure recovery, legacy profile metadata shape, and source-body exclusion. Native lint and TypeScript checks pass. A local one-shot probe confirmed that an asynchronous `profile` callback observes unrelated work on the same event loop while it waits; no live service capture has yet been invoked at this preparation boundary.
