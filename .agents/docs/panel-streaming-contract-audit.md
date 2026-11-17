# Panel streaming and shared idle-axis contract audit

Source revision audited: `8efd10b` (plan cited `6607076`; all paths below re-read at
the working tree). This report confirms or corrects the provisional findings in
`.agents/plans/panel-streaming-idle-axis.md` and sets the compatibility contract
for the planned vertical features. It changes no product source.

Companion plan: `.agents/plans/panel-streaming-idle-axis.md`.
Design contract: `DESIGN.md` §Shared patterns ("Stream the full result … in database
pages … merge live updates … virtualize") and §Trajectory (shared axis, marked
compressed intervals, true timestamps, honest gaps).

## 1. All-collections inventory

Legend: **SQL pages** = keyset/cursor read against the database per page.
**Capture slicing** = one bounded whole capture, then client-side array slices.
**Page guard** = per-page payload safeguard (kept). **Total truncation** = whole
result silently cut (must never read as normal exhaustion).

### 1.1 Tasks (`src/tasks/`, `src/observability/task-reads.ts`)

| Collection                  | Producer                                                                                                                | Transport                                                                      | Consumer                                                                       | Shape                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Task list                   | `TaskReads.query` (`src/tasks/read.ts`) extended by `AssociationTaskReads.query` (`src/observability/task-reads.ts:75`) | Tasks RPC `query` → `TaskPanelState.refresh/more` (`src/tasks/panel-state.ts`) | `execution-list-view.tsx` + TanStack virtualizer (`src/tasks/virtual-rows.ts`) | **SQL pages**                                                                   |
| Count                       | same `query` (`SELECT COUNT(*)`, `task-reads.ts:168`)                                                                   | same page (`page.count`)                                                       | header/filter totals                                                           | exact total, not page-local                                                     |
| Topology (execution links)  | `reads.topology` (`src/observability/rpc.ts:112`, `topology` in `src/observability/*.ts`)                               | `transport.topology()`                                                         | `panel-state.ts:434-452` groups                                                | whole bounded graph, history-free by design (`topology.test.ts:9`)              |
| Scheduling (Next/conflicts) | scheduling read (`src/tasks/scheduling-read*.ts`)                                                                       | `transport.scheduling()` via `readScheduling` (`panel-state.ts:188`)           | scheduling-backed groups                                                       | **SQL pages, fully drained** (limit 100, ≤1000 plans, `panel-state.ts:195-218`) |
| Current activity            | `currentActivity(taskIDs)` producer                                                                                     | `observeCurrentActivity` (`panel-state.ts:314`)                                | row badges/inspector                                                           | bounded enrichment (first 30 + selected, cap 40; 50 ms batching)                |
| Detail / linked detail      | `transport.get`                                                                                                         | `select` / `resolveLinked` (deduped `linkedRequests`)                          | inspector                                                                      | single-row reads                                                                |

Cursor/baseline identity: `{filter, snapshot, before}` (`task-reads.ts:15-19`) where
`filter` is a sha256 of projectDirectory, sessionID, search, scopePath, effective
state filter, includeRetired, sort (`task-reads.ts:80-93`). A cursor from another
filter/sort/snapshot throws (`task-reads.ts:100-102`, covered by
`task-reads.test.ts:410`). Snapshot pinning: `before` is a `t.rowid`; pages after
the first require a stable version, else "Task execution changed; start a fresh
query". Cross-project responses are rejected (`panel-state.ts:432`,
`panel-state.ts:632`). **Verdict: real SQL pages — plan finding CONFIRMED.**

First-page blockers vs enrichment — plan finding CONFIRMED with one correction:
`refresh()` awaits `query` page 1, then `topology`, then fills a **bounded**
`wanted` extent (`panel-state.ts:454-498`: `wanted = max(first page, prior extent +
delta)`), then `readScheduling`. So optional scheduling/topology do not block the
list render, but **there is no background drain to exhaustion**: continuation is
viewport-driven `more(key)` only, one page per call, and `more` is disabled while
`refreshing` or when `moreError` is set (`panel-state.ts:617-673`). A later-page
loop over already-loaded data is therefore impossible, but so is automatic
exhaustion — that is the feature to build. Cycle safety already exists:
`followedCursors`, `STALLED_PAGE` ("The next page did not advance"),
per-page single-flight (`requestedMore`), snapshot-change retry (≤3 attempts).

### 1.2 Radar (`src/radar/`, `src/observability/live-read.ts`, `live-store.ts`)

| Collection                                        | Producer                                                                                 | Transport                                                                                | Consumer                    | Shape                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| Live overview                                     | `liveRadar` (`live-read.ts`, `live-store.ts`)                                            | `RadarMonitorTransport.liveRadar` → `RadarMonitorState.refresh` (`monitor-state.ts:128`) | overview list               | **whole bounded snapshot, no cursor**                 |
| Selected history                                  | progress journal SQL (`live-store.ts:240-268`)                                           | `liveHistory` → `loadHistory` (`monitor-state.ts:325`)                                   | history list                | **SQL pages** (limit 1–25, default 20; opaque cursor) |
| Diagnostics/map/statechart                        | `snapshot`/`radar`/progress-diagnostics reads; `RadarDiagnosticsPanel` (`panel.tsx:104`) | `createRadarTransport` (`panel.tsx:216`)                                                 | diagnostics tab             | whole bounded reads (not live-paged)                  |
| Pickers (project/session scope, unmanaged toggle) | view-local scope + `includeUnmanagedSessions` flag                                       | `connect(key, projectID, scope, …)`                                                      | `panel.tsx:451-477` pickers | scope identity, not a collection                      |

`LIVE_LIMITS` (`live-store.ts:7-24`) is the page-safety vs total-truncation
boundary: sessions 32, inventoryCandidates 256, progressRowsPerSession 17,
toolRowsPerSession 17, progressRowsPerAttempt 50, journalFacts 257,
progressPayloadBytes 4096, sourceRows 1500, sourceBytes 10 MB, sourceQueries 100,
nativeSessionReads 32, responseBytes 512 kB. Every cut sets an explicit
`*Truncated` coverage flag (`contract.ts:561-587`) surfaced as
"unavailable/incomplete" banners — **page guards, CONFIRMED present**. But
`liveRadar` has no cursor and `refresh()` re-reads the whole overview, so large
fleets re-pay the full bounded read per refresh; history continuation is manual
(`loadMoreHistory`, `monitor-state.ts:371`) with no auto-drain. **Plan finding
CONFIRMED**: overview has no cursor; selected history has real keyset pages but
manual continuation. Refresh-head (live `refresh`) and drain-tail (history
`loadHistory`) already have independent ownership (separate controllers, epochs,
`historyController` per selection, `monitor-state.ts:325-375`); the missing piece
is automatic continuation plus a render bound for long histories.

Contributors/sessions note: the overview session cap (32) with
`foreignSessionsExcluded` counting is a **total-result truncation with a count**,
not hidden — keep that pattern for every new paged collection.

### 1.3 Trajectory (`src/trajectory/`, `src/trajectory-panel/`)

| Collection                    | Producer                                                                                  | Transport                                                       | Consumer            | Shape                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task choices                  | `reads.snapshot` → `taskChoices` (`projection.ts:409`)                                    | `transport.snapshot()` → `refresh` (`panel-state.ts:341`)       | task picker         | **whole bounded snapshot** (plans ≤1000, attempts/checks ≤10000, transitions ≤10000; `contract.ts:125-150`)                                                                              |
| Selected history              | `inspectTrajectory` (`read.ts:867`) → `TrajectoryHistoryCache.capture` (`history.ts:126`) | `transport.history()` → `captureHistory` (`panel-state.ts:608`) | event list/timeline | **capture slicing**: one bounded capture (MAX_EVENTS 10 000, MAX_BYTES 8 MB, 16 entries, TTL 5 min), cursor = signed `{offset, binding}` slicing the cached array (`history.ts:201-244`) |
| Live status                   | `trajectoryStatus` (full report + `live {mode, baseCursor, cursor, removed}`)             | `transport.status()` → `refreshStatus` (`panel-state.ts:481`)   | live events lane    | whole-report refresh or `patch` merge                                                                                                                                                    |
| Native context / availability | `host.session` / `status` per attempt (`read.ts:945-970`), ≤10 000 messages/session       | embedded in report `coverage`                                   | availability badges | per-attempt availability, not a paged collection                                                                                                                                         |

**Plan finding CONFIRMED**: selected history captures a bounded whole projection
first, then slices cached arrays (`panel-state.ts:659-705` first page, `896-1007`
`loadMoreActivity` with strict capture-binding checks: same `capturedAt`/
`expiresAt`, expected `eventIDs` order, page-number and cursor-advance checks, else
`PageRecaptureError` → "Recapture history"). Broad choices and native-context
availability have independent bounds (snapshot caps; `MAX_CONTEXT_MESSAGES`
10000 in `read.ts:58`; `unavailableSessionContexts` counted). Following the
history cursor is paging a frozen capture, not database streaming — the producer
change (keyset pages against `runner_progress`/events) belongs to
`src/trajectory/read.ts` + `history.ts`, not the panel.

### 1.4 Models (`src/models/`)

| Collection                     | Producer                                                                                                                                                                                                 | Transport                                                                             | Consumer                 | Shape                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| Task picker                    | tasks query, single read limit 100 (`comparison-panel.tsx:927`)                                                                                                                                          | panel transport                                                                       | picker                   | **one page only — no continuation** (plan finding CONFIRMED)                             |
| Candidates (comparison)        | `comparison-read.ts` over whole evidence snapshots; evidence refs bounded to 100 (`comparison-read.ts:87-97`, `truncated` flag)                                                                          | `comparison(cursor, limit 100)` (`comparison-panel.tsx:906-911`)                      | chart + data alternative | paged transport over snapshot-built groups — verify server-side cursor on implementation |
| Decision rows / configurations | `decision-read.ts` over ledger capture; cursor `{version, kind, snapshotID, offset, …}` (`decision-read.ts:93-102`)                                                                                      | `decisionRows` / `decisionConfigurations` (limit 50) (`comparison-panel.tsx:941-961`) | tables                   | **SQL-backed pages**                                                                     |
| Contributors                   | decision-reader contributor pages                                                                                                                                                                        | `contributorPage.nextCursor` (`comparison-panel.tsx:2691,3032`)                       | inspector                | **paged**                                                                                |
| Decision progress scan         | `observation-ledger-read.ts:489-495`, `DECISION_PROGRESS_BATCH_SIZE = 512` keyset scan                                                                                                                   | internal to ledger capture                                                            | effort basis             | **true 512-row SQL scanner — reuse point CONFIRMED**                                     |
| Ledger capture itself          | `OBSERVATION_LEDGER_LIMITS` (`observation-ledger-read.ts:26-37`: tasks 10k, plans 10k, attempts 20k, transitions 50k, adoptions/dispositions/classifications 20k, progressFacts 10k, captureBytes 64 MB) | `readDecision` snapshot                                                               | all decision reads       | **whole bounded capture** — full projections are then sliced per page                    |

**Plan finding CONFIRMED** with a boundary clarification: paging a whole ledger
capture is capture slicing at one remove. True streaming for Models means pushing
the 512-row scanner pattern down to candidates/decisions/contributors, or
documenting the ledger capture as the page-safety bound. Global financial
statistics must stay computed over the capture, never over the visible page
(current code keeps market/range math in `market-range.ts`/`reference-estimate.ts`
over cohorts — preserve that ownership).

### 1.5 Pickers, Diagnostics, contributors — complete enumeration

- Tasks: state/sort/search/scopePath pickers are part of the cursor filter hash
  (safe); activity/session pickers are enrichment-only.
- Radar: scope picker + unmanaged-sessions toggle are scope identity
  (`scopeMatches`, `historyMatches`, `monitor-state.ts:36-51`); Diagnostics tab
  reads snapshot/radar/diagnostics endpoints whole-bounded — large-fleet
  streaming must include or explicitly exclude Diagnostics (recommend: exclude
  from live paging; Diagnostics keeps whole-bounded reads with truncation flags).
- Trajectory: task picker is the snapshot task list (bounded by snapshot caps);
  no separate picker producer.
- Models: task picker (one page — must page), persona filter (LZ-216 owned —
  do not duplicate), price-source setting (independent of paging).

## 2. Stream-and-live contract

### 2.1 Baseline identities (what makes a page belong to a read)

| Surface            | Baseline                                                                                                    | Mismatch behavior                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Tasks list         | cursor `{filter sha256, snapshot version, before rowid}`                                                    | throw; fresh query required                 |
| Tasks scheduling   | `(scope, snapshotID, repositoryVersion)` per page (`panel-state.ts:197-214`)                                | throw "pages changed during the read"       |
| Radar live         | `(projectID, scope)` per response (`monitor-state.ts:156`)                                                  | throw "belongs to another project or scope" |
| Radar history      | `(projectID, scope, sessionID)` per page (`monitor-state.ts:347`)                                           | throw; restart                              |
| Trajectory status  | `(projectID, scope, taskID)` + `baseCursor` for patches (`panel-state.ts:500-506,544`)                      | throw; resynchronize                        |
| Trajectory history | `(projectID, scope, taskID, capturedAt, expiresAt)` + ordered `eventIDs` (`panel-state.ts:682-707,949-983`) | `PageRecaptureError` → explicit recapture   |
| Models decisions   | cursor `{version 1, kind, snapshotID, offset, limit, inputFingerprint}` (`decision-read.ts:93`)             | reject; re-read                             |

**Compatibility rule for all verticals**: every cursor is opaque, single-use,
bound to one baseline tuple; every page re-asserts the tuple; any mismatch
restarts that collection only (never the whole panel). Cursors never cross
scope/filter/server generations. Keep the existing per-surface error strings;
they are the contract clients branch on (`live_history_unavailable`,
`trajectory_history_unavailable`, task cursor errors).

### 2.2 Cancellation and stale-response boundaries

Established pattern (Tasks `panel-state.ts:154-186`, Radar `monitor-state.ts:66-99`,
Trajectory `panel-state.ts:184-210`): per-connection `AbortController` +
monotone generation/epoch counters + per-read request counters; `close()`
aborts and invalidates everything. Stale responses are dropped by
generation/request/identity comparison before any state write. Selection-scoped
reads (detail, history) have their own controllers so list refreshes never cancel
an in-flight selection read and vice versa. **New streaming loops must reuse
this pattern**: the background drain needs its own abort scope tied to
`connect`/`close` and to scope/filter changes, with `isCurrent()`-style guards
on every page await. LZ-216 owns the filter identity; streaming consumes it.

### 2.3 Live upsert/removal races

- Tasks: version-gated `watch` → `refresh` on `version > page.snapshot`
  (`panel-state.ts:760-793`); activity keyed per task, refresh-safe.
- Radar: sequence-gapped `receiveChange` → `resynchronizing` + catch-up refreshes
  (≤2, `monitor-state.ts:242-244`); stream-epoch change → full resync baseline.
- Trajectory: `eventSequence` buffering during refresh (`panel-state.ts:1017-1029`);
  status `patch` mode applies `removed` IDs and merges by event id
  (`panel-state.ts:543-553`); settled-history polling stops live reads for
  terminal plans (`settledHistory`, `projection.ts:619`) with fingerprint
  re-check (`taskSnapshotFingerprint`) to catch resumes.

**Race rule**: live events that arrive during paging merge by stable identity
(taskID, sequence, event id) and never shift already-published page boundaries;
a baseline change (snapshot/version/epoch/capture expiry) invalidates the chain
and restarts from page one. Removal during drain marks the item removed; the
drain continues to exhaustion of the _new_ baseline, not the old count.

### 2.4 Head/tail ownership

Radar already splits head (live `refresh`) from tail (history `loadHistory`);
Trajectory splits snapshot/task-choice refresh from history capture from status
polls. Preserve one owner per direction: head reads own live merging, tail reads
own cursor chains; they rendezvous only on selection identity. Do not create
competing producer writers — see §2.6.

### 2.5 Error / retry / exhaustion semantics

| Signal                             | Meaning            | UI                                                                                                            |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| First page failure                 | nothing usable     | full-panel error + retry; backoff 1 s → 30 s (`retryRead`, `retryRefresh`)                                    |
| Later-page failure                 | prior pages stay   | `moreError`-style per-collection flag; explicit retry re-reads only the failed cursor; list stays interactive |
| Repeated cursor / no-progress page | would loop forever | stop, keep progress, require explicit retry (`STALLED_PAGE`)                                                  |
| Cursor/expiry invalidation         | baseline moved     | recapture/restart message naming the recovery ("Recapture history", "start a fresh query")                    |
| `nextCursor: null`                 | normal exhaustion  | terminal state, distinct from every truncation flag                                                           |
| `*Truncated` coverage flag         | page guard cut     | "incomplete/showing partial" banner, never silent                                                             |

**Never label capture truncation as normal exhaustion.** Every new paged
collection needs both a `nextCursor` (more data) and truncation/coverage flags
(guards cut data) as separate signals.

### 2.6 Rendering bounds and shared-file ownership

Existing bounds: Tasks virtualizer (`virtual-rows.ts`), Radar none for history
(to add), Trajectory windowing via `loadMoreActivity` + `loadingActivity`,
Models chart/data-alternative disclosure. New work must add a mounted-node bound
for Radar history and Trajectory event lists (the two unbounded append paths).

Shared-file ownership (do not duplicate LZ-216 filter scope):

- `src/observability/contract.ts` — shared RPC shapes; changes need Radar +
  Trajectory sign-off (Architect sequences).
- `src/observability/live-read.ts`, `live-store.ts`, `changes.ts` — **Radar
  owns** producer edits; Trajectory may read, not fork.
- `src/observability/task-reads.ts`, `src/tasks/read.ts` — **Tasks owns**.
- `src/trajectory/read.ts`, `history.ts`, `store.ts` — **Trajectory owns**
  producer edits; Models consumes via `readDecision`, never by copying rows.
- `src/progress/projection.ts`, `src/trajectory/accounting.ts`,
  `src/trajectory/privacy.ts` — shared read-only projections; change by
  agreement, with the existing tests as the gate.
- `src/models/observation-ledger-read.ts` — **Models owns**; its 512-row
  scanner is the reuse pattern for other SQL paging, not a shared writer.

## 3. Truthful shared axis

### 3.1 Every caller of the shared placement transform

One linear transform exists today and **every** lane already shares it —
the plan's "independent per-track scale guesses" is CORRECTED: there is a single
`origin + durationMs` domain built by `buildTimeline`
(`trajectory-panel/projection.ts:651-752`), and all lanes derive `left/width`
percentages from it:

- Attempts and checks geometry: `projection.ts:681-743` (`position(at)`).
- Ruler ticks: `tickStep`/`elapsedLabel` (`projection.ts:562-574`) and
  width-adaptive `tickStepFor` + `visibleTicks` (`panel.tsx:474-479`,
  `panel-layout.ts:6-25`).
- Tool/file/gap marks: `buildTracks` (`tracks.ts:154-268`) takes the same
  `Pick<Timeline, "origin" | "durationMs">` and applies the identical
  `((at - origin) / duration) * 100` mapping (`tracks.ts:162-165`).
- Domain inputs: `trackTimes` (tool/gap endpoint times, `tracks.ts:325-336`)
  feed `buildTimeline` as `extraTimes` (`panel.tsx:406-412`).
- Hit testing: `nearestMark` with tolerance (`tracks.ts:299`); keyboard:
  `neighborMark` (`tracks.ts:280`); both operate on the shared `left` values.
- Scroll/zoom: `zoom` signal + `ZOOM_LEVELS` (`tracks.ts:317-322`), scroll anchor
  preserve/restore via `data-scroll-anchor` (`panel.tsx:115-146`), horizontal
  `timelineScroll.scrollLeft` preservation (`panel.tsx:233-239`).
- Open-ended present: `openEnd` extends the axis and the active attempt's last
  segment only (`projection.ts:663-667`); never a recorded end.
- Unloaded tail: `pendingAfter` → `loadedThrough` (`tracks.ts:266`,
  `panel.tsx:421`) shades where captured events are not yet loaded.

**Constraint for compression**: keep exactly one monotonic transform object
`{origin, durationMs, compressedIntervals}` owned by `projection.ts`; every
caller above consumes it. No per-lane math.

### 3.2 What can distinguish known idle from active/overlapping work

Available time facts (all nullable-by-design):

- Attempt intervals: `startedAt` recorded; `endedAt` null while active; basis
  strings carried on every endpoint (`projection.ts:817-829`).
- Model-activity endpoints: native session `busy`/`idle` ("model activity only;
  idle is not task acceptance").
- Tool marks: `start`/`end` with `startSource`/`endSource`; `pointOnly` when an
  endpoint is missing; `untimedTools` counted, not placed (`tracks.ts:200-240`).
- Checks: `checkTiming` states `known | missing-start | missing-end |
missing-endpoints | invalid-order` (`projection.ts:763-797`); only `known`
  yields a width.
- Gap marks: `worker-gap` (with `reason`) and `compaction` kinds (`tracks.ts:182-197`).

What is **unknown**, and must never render as idle:

- Unloaded pages (`eventCursor` non-null; `loadedThrough` shading).
- Unavailable sessions (`attemptsWithoutRecordedSessions`,
  `availableSessionContexts` vs `unavailableSessionContexts`).
- Compacted/omitted history (`compacted`, `omittedReasoning/System/Attachments`,
  `fullSessionHistory: "not guaranteed"`).
- Native-context absence (`sessionStatus: missing|unavailable`, message-status
  errors in `read.ts:931-970`).
- Overlapping tracks: concurrent attempts/tools/checks/file marks share wall
  time; an interval empty on one track may be busy on another. Compression must
  consider the **union** of all tracks, never one lane alone.

### 3.3 Safe compression boundaries

Compress an interval **only if all** hold: both endpoints recorded (`known`
timing), every overlapping track's sessions available for the span, capture
complete (no pending cursor over the span, no `loadedThrough` cut inside it),
no compaction/gap marks of unknown meaning inside it, and the interval is empty
across the union of attempts, checks, tools, files, and live events. Everything
else renders at true linear scale with its existing unknown-state glyph
(`pointOnly`, `untimedTools` count, gap marks, `loadedThrough` shading).
Inspector times and durations always show wall-clock values (`durationText`,
`elapsedLabel`); the compressed axis is a display mapping with a marked,
invertible visual policy (one tested transform + inverse for hit-testing, so
`nearestMark` keeps working in compressed space).

### 3.4 Producer/coverage changes needed (no new idle facts exist)

No producer emits "known idle" today — absence of marks is not evidence. Truthful
compression needs one of: (a) explicit idle facts from the runner (idle spans
with both endpoints and a basis string, same vocabulary as checks), or (b) a
coverage-interval projection over `runner_progress`/session busy-idle endpoints
proving continuous observation across the span. Either lives in
`src/trajectory/read.ts` + `progress/projection.ts` (shared, Radar-aware) and is
consumed read-only by `trajectory-panel/`. Until then, the honest scope is:
compress nothing, keep the linear axis, and keep gaps/unloaded states visually
distinct. `DESIGN.md`'s "known idle" wording is a data requirement, not a
rendering license.

## 4. Verification map

### 4.1 Existing relevant tests (reuse, do not re-prove)

- Tasks paging/cursors: `src/observability/task-reads.test.ts` (cursor walk,
  filter-mismatch throw, schedule-sort cursor rejection); `src/tasks/`
  `scheduling-read.test.ts` (pinned cursors, stale/cross-scope rejection,
  > 100 waiting-plan bounds); `virtual-rows.test.ts` (windowing math).
- Tasks controller: panel-state stall/cycle/retry behavior is exercised via
  panel-state tests where present; keep `STALLED_PAGE` assertions on any drain
  change.
- Radar: `monitor-state.test.ts` (selection preservation, history paging,
  gap/resync paths), `transport.test.ts`, `monitor-model.test.ts`,
  `projection.test.ts`, `layout*.test.ts`.
- Trajectory: `history.test.ts` (capture/cursor/expiry), `read.test.ts`,
  `store.test.ts`, `live.test.ts` (patch/upsert/removal projection),
  `native.test.ts`, `privacy.test.ts`, `accounting.test.ts`.
- Axis math: `projection`/`tracks` unit tests where present
  (`tickStep`, `elapsedLabel`, `durationText`, `checkTiming`, `neighborMark`,
  `nearestMark`, `nextZoom`); add any missing before compression work.
- Models: `comparison-read.test.ts`, `decision-*` tests, `source-store.test.ts`
  (cursor rejection), `valuation.test.ts`, `observation-ledger` tests.

### 4.2 Discriminating focused checks per feature

1. **Prompt first page while later work is blocked**: first-page render must not
   await topology/scheduling/ledger capture — test by stalling the optional
   producer and asserting rows render with an enrichment-pending state.
2. **Automatic exhaustion without interaction**: seed N pages, assert the drain
   reaches `nextCursor: null` with no `more()`/scroll/click calls and bounded
   task/microtask budget.
3. **Live mutation during paging**: insert/remove/update mid-drain; assert merge
   by stable identity, no duplicated or shifted pages, baseline change restarts
   the chain from page one.
4. **Cancellation/filter reset**: change scope/filter mid-drain; assert the old
   chain aborts (no further writes) and the new chain starts from page one with
   its own cursor identity.
5. **Failure recovery**: fail page k; assert pages 1..k-1 stay interactive,
   retry re-reads only cursor k, repeated-cursor/no-progress stops with a named
   error (never a spin).
6. **Bounded mounting**: assert mounted rows/marks stay under the bound while
   the collection drains past it (virtualizer/windowing), for Radar history and
   Trajectory events especially.
7. **Cross-track idle/gap alignment**: fixture with overlapping attempts, a
   recorded gap, an unloaded page, and an unavailable session; assert identical
   `left` mapping across lanes, true inspector times, and that only the
   all-conditions-met span compresses (or nothing compresses until coverage
   facts exist).

### 4.3 Unsupported claims and product decisions (explicit)

- The plan's "later-page loop over already truncated data" failure mode does
  not exist in Tasks (bounded `wanted` loop + stall guards); the real gap is
  the absence of background drain, not a correctness bug. No repair needed.
- "Independent per-track scale guesses" is corrected: one shared linear
  transform already exists; compression must preserve single-transform
  ownership, not create it.
- Absent history/telemetry is not known idle (§3.4). If product wants idle
  compression before coverage facts exist, that is a deliberate
  truthfulness tradeoff for Architect to approve explicitly — not an
  engineering default.
- Diagnostics (Radar map/statechart) and Models global financial statistics
  stay out of per-page streaming scope: Diagnostics keeps whole-bounded reads
  with truncation flags; financials stay capture-global.
- LZ-216 owns normalized multi-state filtering and the Tasks query identity;
  streaming consumes that identity and must not redefine it.
