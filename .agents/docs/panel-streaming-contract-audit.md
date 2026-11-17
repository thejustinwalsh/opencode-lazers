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
state filter, includeRetired, sort (`task-reads.ts:80-93`). `before` is the last
visible row's position: under the default recent sort it is `t.rowid`, but under
`schedule` sort it is the computed schedule ordinal (`scheduledTaskPageSQL`,
`schedule-order.ts:2-20`), not universally a rowid. A cursor from another
filter/sort/snapshot throws (`task-reads.ts:100-102`, covered by
`task-reads.test.ts:410`). Snapshot pinning rejects post-snapshot _execution
mutations_ (`task_changes` mutation id newer than the pinned version,
`task-reads.ts:108-115`), not every version advance; unpaged reads simply pin
the current version. Cross-project responses are rejected (`panel-state.ts:432`,
`panel-state.ts:632`). **Verdict: real SQL pages — plan finding CONFIRMED.**

First-page blockers vs enrichment — plan finding CONFIRMED, and stronger than
first reported: first task rows are published only in the single `update()` at
`panel-state.ts:552-565`, which runs **after** the first query page
(`panel-state.ts:429`), the topology read (`panel-state.ts:438`), the bounded
extent fill (`panel-state.ts:475-498`), **and** the scheduling drain
(`panel-state.ts:506`, up to 10 × 100-row SQL pages, ≤1000 plans). Topology and
scheduling failures degrade to error text but the awaits still serialize
publication, so optional enrichment **does block** useful first rows today;
prompt first-page publication is feature work, not existing behavior (correcting
the prior revision's nonblocking claim). Only current activity is true
post-publish enrichment (`observeCurrentActivity` runs after the update).
**There is no background drain to exhaustion**: continuation is viewport-driven
`more(key)` only, one page per call, disabled while `refreshing` or when
`moreError` is set (`panel-state.ts:617-673`). Cycle safety exists
(`followedCursors`, `STALLED_PAGE` ("The next page did not advance"),
per-page single-flight (`requestedMore`), snapshot-change retry ≤3 attempts) —
a cycle guard is not a drain loop.

### 1.2 Radar (`src/radar/`, `src/observability/live-read.ts`, `live-store.ts`)

| Collection                                        | Producer                                                                                 | Transport                                                                                | Consumer                    | Shape                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live overview                                     | `liveRadar` (`live-read.ts`, `live-store.ts`)                                            | `RadarMonitorTransport.liveRadar` → `RadarMonitorState.refresh` (`monitor-state.ts:128`) | overview list               | **whole bounded snapshot, no cursor**                                                                                                                                                                                           |
| Selected history                                  | progress journal SQL (`live-store.ts:240-268`)                                           | `liveHistory` → `loadHistory` (`monitor-state.ts:325`)                                   | history list                | **SQL pages** (limit 1–25, default 20; opaque cursor)                                                                                                                                                                           |
| Diagnostics/map/statechart                        | `snapshot`/`radar`/progress-diagnostics reads; `RadarDiagnosticsPanel` (`panel.tsx:104`) | `createRadarTransport` (`panel.tsx:216`)                                                 | diagnostics tab             | whole bounded reads (not live-paged) — **in scope per plan §77-83; head `refresh` blocks on whole `liveRadar` read (`monitor-state.ts:132-151`) and selection/history resets re-read whole state (`monitor-state.ts:202-213`)** |
| Pickers (project/session scope, unmanaged toggle) | view-local scope + `includeUnmanagedSessions` flag                                       | `connect(key, projectID, scope, …)`                                                      | `panel.tsx:451-477` pickers | scope identity, not a collection                                                                                                                                                                                                |

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
manual continuation. **Correction to the prior revision: independent head/tail
ownership is missing.** The live head refresh (`monitor-state.ts:238-241`)
calls the same `loadHistory` (`monitor-state.ts:325-359`) as the tail: it aborts
the one shared `historyController`, resets `historyEpoch`, and overwrites
`history`/`nextCursor` (`monitor-state.ts:234-236`). A live tick during a tail
drain therefore discards tail progress and restarts from page one; head and
tail rendezvous only destructively on selection identity. Establishing
independent ownership — separate controllers/cursors for head refresh vs tail
drain, with merge-by-sequence instead of overwrite — is feature work. The
missing piece beyond that is automatic continuation plus a render bound for long
histories.

Coverage-flag corrections (prior revision misread two): `foreignSessionsExcluded`
counts sessions belonging to _other projects_ (`live-read.ts:880-882,946-948`),
not cap overflow; the actual inventory cut without a count is
`inventoryTruncated` (`live-read.ts:935-936`), including dedupe/archive drops
(`live-read.ts:884-887`). A flagged collection cut is still a collection cut:
distinguish it from per-page payload guards (payload truncation to 4096 bytes,
`payloadTruncated`) — the former ends the collection early, the latter only
shortens one row.

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
`src/trajectory/read.ts` + `history.ts`, not the panel. Loaded pages are
**appended whole and mounted whole**: `loadMoreActivity` concatenates every
loaded event (`panel-state.ts:983-986`) and the event list renders all of them
(`panel.tsx:2059-2075`, one button per event with no windowing). The
`loadingActivity` flag only serializes reads; there is no mounted-node bound —
correcting the prior revision's windowing claim.

### 1.4 Models (`src/models/`)

| Collection                     | Producer                                                                                                                                                                                                 | Transport                                                                                                                                            | Consumer                 | Shape                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| Task picker                    | tasks query, single read limit 100 (`comparison-panel.tsx:927`)                                                                                                                                          | panel transport                                                                                                                                      | picker                   | **one page only — no continuation** (plan finding CONFIRMED)                   |
| Candidates (comparison)        | `candidatesFor` rebuilds + sorts the full retained array per read, then `slice(offset, offset + limit)` (`comparison-read.ts:392-405`; cursor `{offset, filters, snapshots}`)                            | `comparison(cursor, limit 100)` (`comparison-panel.tsx:906-911`)                                                                                     | chart + data alternative | **capture/projection slicing, not DB pages**                                   |
| Decision rows / configurations | `rowPage`/`configurationPage` slice in-memory snapshot arrays (`decision-read.ts:1504-1554`; cursor `{version 1, kind, snapshotID, offset, …}`)                                                          | `decisionRows` / `decisionConfigurations` (limit 50) (`comparison-panel.tsx:941-961`)                                                                | tables                   | **capture/projection slicing, not DB pages**                                   |
| Contributors                   | `inspection` sorts the full retained contributor array per read, then slices (`decision-read.ts:1572-1618`)                                                                                              | `contributorPage.nextCursor` (`comparison-panel.tsx:2691,3032`)                                                                                      | inspector                | **capture/projection slicing, not DB pages**                                   |
| Decision progress scan         | true 512-row keyset drain (`DECISION_PROGRESS_SQL … ORDER BY r.seq LIMIT ?`, `observation-ledger-read.ts:460-466`; drain loop `487-515`; digest independent of page boundaries `508-512`)                | internal to ledger capture (`options.decision` branch, `749-758`; generic `LIMIT progressFacts+1` branch `760-775` applies only when _not_ decision) | effort basis             | **SQL pages — reuse point CONFIRMED**                                          |
| Ledger capture itself          | `OBSERVATION_LEDGER_LIMITS` (`observation-ledger-read.ts:26-37`: tasks 10k, plans 10k, attempts 20k, transitions 50k, adoptions/dispositions/classifications 20k, progressFacts 10k, captureBytes 64 MB) | `readDecision` snapshot                                                                                                                              | all decision reads       | **whole bounded capture** — document capture size as a guard, not as streaming |

**Correction to the prior revision**: candidates, decision rows/configurations,
and contributors are **capture/projection slicing, not DB pages** — each read
rebuilds or holds the full retained projection and serves `slice()` windows off
it. Do not classify cursor-over-array as database streaming; capture-size
documentation does not satisfy the DB-streaming outcome. The one true SQL
paging pattern in Models is the decision-progress 512-row drain
(`observation-ledger-read.ts:487-515`), and the generic 10k progress cap plus
byte-payload accounting (`760-775`, `780-799`, `832-839`) do **not** uniformly
apply to that decision branch — each branch carries its own accounting. True
streaming for Models means pushing the 512-row scanner pattern down to
candidates/decisions/contributors (or keying them to SQL), while global
financial statistics stay computed over the capture, never over the visible
page (market/range math in `market-range.ts`/`reference-estimate.ts` over
cohorts — preserve that ownership). Publication is also gated: decision rows,
configurations, and sources must cohere on one snapshotID (two-attempt
reconciliation, else throw) before the single decision `update()`
(`comparison-state.ts:599-688`) — first decision rows wait for the whole
capture, mirroring the Tasks first-page blocker.

### 1.5 Pickers, Diagnostics, contributors — complete enumeration

- Tasks: state/sort/search/scopePath pickers are part of the cursor filter hash
  (safe); activity/session pickers are enrichment-only.
- Radar: scope picker + unmanaged-sessions toggle are scope identity
  (`scopeMatches`, `historyMatches`, `monitor-state.ts:36-51`); Diagnostics tab
  reads snapshot/radar/diagnostics endpoints whole-bounded and stays **in
  scope** per plan §77-83 — streaming work must page or bound it, not exclude
  it.
- Trajectory: task picker is the snapshot task list (bounded by snapshot caps);
  no separate picker producer.
- Models: task picker (one page — must page); persona/kind comparison filters
  are Models-owned panel state (`decisionFilters`, `comparison-panel.tsx:2064-2084`) —
  **LZ-216 owns only the Tasks state filter/query identity, not the Models
  persona filter** (correcting the prior revision); price-source setting is
  independent of paging.

## 2. Stream-and-live contract

### 2.1 Baseline identities (what makes a page belong to a read)

| Surface            | Baseline                                                                                                                                                                                                                             | Mismatch behavior                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Tasks list         | cursor `{filter sha256, snapshot version, before position}` (position = rowid under recent sort, schedule ordinal under schedule sort)                                                                                               | throw; fresh query required                                                                                  |
| Tasks scheduling   | `(scope, snapshotID, repositoryVersion)` per page (`panel-state.ts:197-214`)                                                                                                                                                         | throw "pages changed during the read"                                                                        |
| Radar live         | `(projectID, scope)` per response (`monitor-state.ts:156`)                                                                                                                                                                           | throw "belongs to another project or scope"                                                                  |
| Radar history      | cursor binds `(projectID, scope, sessionID, limit, attemptID, runnerRevision, beforeSequence)` (`live-store.ts:660-670`); revision revalidated per read (`live-store.ts:685-688`); source budgets enforced (`live-store.ts:690-694`) | `session-unavailable` / `invalid-cursor` / `changed-during-read` → restart (`live-store.ts:616-619,687-688`) |
| Trajectory status  | `(projectID, scope, taskID)` + `baseCursor` for patches (`panel-state.ts:500-506,544`)                                                                                                                                               | throw; resynchronize                                                                                         |
| Trajectory history | `(projectID, scope, taskID, capturedAt, expiresAt)` + ordered `eventIDs` (`panel-state.ts:682-707,949-983`)                                                                                                                          | `PageRecaptureError` → explicit recapture                                                                    |
| Models decisions   | cursor `{version 1, kind, snapshotID, offset, limit, inputFingerprint (+configurationID/selectedTaskID for contributors)}` (`decision-read.ts:93-102`)                                                                               | reject; re-read                                                                                              |

**Compatibility rule for all verticals (proposed; current state noted per
surface above)**: every cursor is opaque and bound to one baseline tuple; every
page re-asserts the tuple; any mismatch restarts that collection only (never the
whole panel). Cursors are **replayable, not single-use**: explicit retry
re-reads the same cursor (`retryMore`, `loadMoreHistory` after failure), while
_advancement_ must be cyclic-guarded (`followedCursors`, `STALLED_PAGE`,
`nextCursor === requestedCursor` rejection in `panel-state.ts:693-698`). Do not
conflate retry replay with cyclic advancement. Cursors never cross
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

**Current behavior: Radar head and tail are NOT independently owned** (correcting
the prior revision). Both the live head refresh (`monitor-state.ts:238-241`) and
the tail (`loadMoreHistory`, `monitor-state.ts:371`) funnel into the same
`loadHistory` with one shared `historyController`/`historyEpoch`, and the head
path overwrites `history`/`nextCursor` (`monitor-state.ts:234-236`). Trajectory
does split snapshot/task-choice refresh from history capture from status polls,
so its directions already have separate request scopes. **Proposed contract**:
preserve one owner per direction — head reads own live merging, tail reads own
cursor chains; they rendezvous only on selection identity, with merge-by-stable-identity
instead of overwrite. Do not create competing producer writers — see §2.6.

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

Existing bounds: Tasks virtualizer (`virtual-rows.ts`); Models chart/data-alternative
disclosure (which mounts all choices — `comparison-panel.tsx:1206-1209` — inside a
collapsed disclosure, not a window). No mounted-node bound exists for Radar
history or the Trajectory event list — both append-all/mount-all paths. New work
must add a mounted-node bound for exactly those two.

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

One linear domain exists today and every lane shares it — but the mapping math
is **duplicated, not single-sourced** (correcting the prior revision's
"single transform" claim). `origin + durationMs` is built once by
`buildTimeline` (`trajectory-panel/projection.ts:651-752`), yet the
`((at - origin) / duration) * 100` percentage is recomputed independently in
`projection.ts:680` (`position`), `tracks.ts:162-165` (`left`),
`panel-layout.ts:15` (`visibleTicks` position), and `panel.tsx:1071-1090`
(tick/gridline `left` styles):

- Attempts and checks geometry: `projection.ts:681-743` (`position(at)`).
- Ruler ticks: `tickStep`/`elapsedLabel` (`projection.ts:562-574`) and
  width-adaptive `tickStepFor` + `visibleTicks` (`panel.tsx:474-479`,
  `panel-layout.ts:6-25`).
- Tool/file/gap marks: `buildTracks` (`tracks.ts:154-268`) takes the same
  `Pick<Timeline, "origin" | "durationMs">` and applies the identical
  `((at - origin) / duration) * 100` mapping (`tracks.ts:162-165`).
- Domain inputs: `trackTimes` (tool/gap endpoint times, `tracks.ts:325-336`)
  feed `buildTimeline` as `extraTimes` (`panel.tsx:406-412`).
- Hit testing: `nearestMark` with tolerance (`tracks.ts:299`) operates on shared
  `left`; keyboard `neighborMark` (`tracks.ts:280-294`) operates on **array
  indices, not positions** — compression must keep index order consistent with
  visual order or re-target keyboard focus by position.
- Scroll/zoom: `zoom` signal + `ZOOM_LEVELS` (`tracks.ts:317-322`), scroll anchor
  preserve/restore via `data-scroll-anchor` (`panel.tsx:115-146`), horizontal
  `timelineScroll.scrollLeft` preservation (`panel.tsx:233-239`).
- Open-ended present: `openEnd` extends the axis and the active attempt's last
  segment only (`projection.ts:663-667`); never a recorded end.
- Unloaded tail: `pendingAfter` → `loadedThrough` (`tracks.ts:266`,
  `panel.tsx:421`) shades where captured events are not yet loaded.

**Constraint for compression**: consolidate to exactly one monotonic transform
`{origin, durationMs, compressedIntervals}` owned by `projection.ts` (eliminating
the four duplicated mappings above); every caller consumes it, and the inverse
is tested so `nearestMark` keeps working in compressed space. No per-lane math.

### 3.2 What can distinguish known idle from active/overlapping work

Partial time facts exist today, but none proves continuous cross-track idleness:

- Attempt intervals: `startedAt` recorded; `endedAt` null while active; basis
  strings carried on every endpoint (`projection.ts:817-829`).
- Session/model endpoints: `read.ts:510-517` (message `idle` outcome) and
  `read.ts:808-827` (native session `busy`/`idle` as model-activity bounds,
  "idle is not task acceptance"). These are **per-session point observations,
  not continuous cross-track coverage** — they bound one session's model
  activity and say nothing about sibling tracks or unobserved spans (correcting
  the prior revision's "nothing marks idle" overstatement in the other
  direction: endpoints exist, coverage does not).
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

### 3.4 Producer/coverage changes needed (idle facts exist; idle _coverage_ does not)

No producer emits a continuous known-idle span — absence of marks is not
evidence, and point endpoints do not compose into cross-track coverage.
Truthful compression needs one of: (a) explicit idle facts from the runner
(idle spans with both endpoints and a basis string, same vocabulary as checks),
or (b) a coverage-interval projection over `runner_progress`/session busy-idle
endpoints proving continuous observation across the span. Either lives in
`src/trajectory/read.ts` + `progress/projection.ts` (shared, Radar-aware) and is
consumed read-only by `trajectory-panel/`. **"Compress nothing" is a temporary
safety fallback, not feature acceptance and not a user truthfulness waiver**:
it ships no compression behavior, and the linked feature work must deliver the
coverage/span producer plus a **positive compression fixture** (a span meeting
every §3.3 condition visibly compresses with marked intervals and true
inspector times) alongside the negative fixtures in §4.2.7. `DESIGN.md`'s
"known idle" wording is a data requirement, not a rendering license.

## 4. Verification map

### 4.1 Existing relevant tests (reuse, do not re-prove)

- Tasks paging/cursors: `src/observability/task-reads.test.ts` (cursor walk,
  filter-mismatch throw, schedule-sort cursor rejection); `src/tasks/`
  `scheduling-read.test.ts` (pinned cursors, stale/cross-scope rejection,
  > 100 waiting-plan bounds); `virtual-rows.test.ts` (windowing math).
- Tasks controller: panel-state stall/cycle/retry behavior — keep
  `STALLED_PAGE` assertions (`panel-state.ts:137-138`) on any drain change;
  cover the 3-attempt snapshot-retry path (`panel-state.ts:428-500`).
- Radar: `monitor-state.test.ts` (selection preservation, history paging,
  gap/resync paths), `transport.test.ts`, `monitor-model.test.ts`,
  `projection.test.ts`, `layout*.test.ts`.
- Trajectory: `history.test.ts` (capture/cursor/expiry), `read.test.ts`,
  `store.test.ts`, `live.test.ts` (patch/upsert/removal projection),
  `native.test.ts`, `privacy.test.ts`, `accounting.test.ts`.
- Axis math: `projection`/`tracks` unit tests (`tickStep`, `elapsedLabel`,
  `durationText`, `checkTiming`, `neighborMark`, `nearestMark`, `nextZoom`) —
  extend with a compression-transform suite (monotonicity, inverse round-trip,
  marked-interval preservation) before compression work.
- Models: `comparison-read.test.ts` (cursor/filter mismatch), `decision-*`
  tests, `source-store.test.ts` ("Model evidence page cursor is unavailable"),
  `valuation.test.ts`, observation-ledger tests.

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
6. **Bounded mounting**: assert mounted rows/marks stay under the bound
   while the collection drains past it — Tasks virtualizer exists
   (`virtual-rows.ts`); Radar history and Trajectory events need the bound
   added (both mount-all today).
7. **Cross-track idle/gap alignment**: negative fixtures — overlapping
   attempts, a recorded gap, an unloaded page, an unavailable session, a
   compacted span; assert identical mapping across lanes, true inspector
   times, and no compression while any §3.3 condition fails. Positive
   fixture — a span meeting **all** §3.3 conditions visibly compresses,
   interval marked, with `nearestMark`/`neighborMark` still resolving to the
   same marks.

### 4.3 Unsupported claims and product decisions (explicit)

- No "later-page loop over already truncated data" failure mode is claimed:
  Tasks fills a bounded `wanted` extent with stall guards and stops; the gap
  is the absence of background drain to exhaustion, not a correctness bug.
  No repair needed.
- "Independent per-track scale guesses" is corrected: one shared linear
  domain exists but the mapping math is duplicated in four places
  (projection, tracks, panel-layout, panel); compression must consolidate to
  a single tested transform + inverse, not add a fifth mapping.
- Point session-idle/model endpoints exist (`read.ts:510-517,808-827`) but do
  not compose into continuous cross-track coverage (§3.2). If product wants
  idle compression before the coverage/span producer exists, that is a
  deliberate truthfulness tradeoff for Architect to approve explicitly — not
  an engineering default, and "compress nothing" is a safety fallback, not
  acceptance.
- Radar Diagnostics (map/statechart) stays in streaming scope per plan §77-83
  (correcting the prior revision's exclusion): page or bound it; do not drop
  it. Models global financial statistics stay capture-global without blocking
  rows on the whole capture.
- LZ-216 owns normalized multi-state filtering and the Tasks query identity
  only — not the Models persona filter; streaming consumes the Tasks
  identity and must not redefine it.
