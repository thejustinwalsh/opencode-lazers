# Data handling: the database is the working set

LAZERS keeps its state in SQLite (`tasks.sqlite`) and reads OpenCode's state through
the host API. Today much of the code treats the database as a log to replay: it loads
rows and JSON documents into memory and rebuilds a view from them, on every timer,
event and read, once per plugin copy. That is why the service needs gigabytes. This
design makes the database the working set: queries return only what a caller shows,
derived views are stored and updated as data changes, and memory holds only what is
in flight.

## Why memory grows today

| Pattern                       | Where it shows up                                                                                                                                   | Effect                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Replay instead of query       | Progress `assignments()` parses every task body every 5 s; runner ticks load 1000 plan bodies; Models rebuilds the decision ledger from all history | Allocation proportional to history, repeated forever                           |
| Document rows                 | Plans, receipts, evidence and reports stored as JSON blobs; callers parse whole documents (often with zod) to read one field                        | Gigabytes of short-lived objects; zod and `JSON.parse` dominate stall profiles |
| Mirror the host by full reads | `session.context` returns a whole conversation (up to 10 000 messages); about 20 call sites, two per call in places                                 | Each read materializes a conversation                                          |
| One copy per location         | About 44 plugin copies each own caches (2 × 128 MB trajectory), recorders, subscribers, publishers and a Models worker                              | Every cost × 44                                                                |
| Rewrite on append             | Receipt and event-id histories parsed and rewritten whole per append                                                                                | Quadratic work as history grows                                                |
| No retention                  | `tasks.sqlite` 2.58 GB; nothing prunes evidence snapshots, transitions or progress facts                                                            | Every full read gets slower and larger                                         |

Counts in `src/` (non-test, 2026-11-20): 324 `.all()` reads, 80 `SELECT *`, 270 sites
with `LIMIT`, 20 `session.context` callers.

## Principles

### 1. Query, don't replay

SQLite filters, joins, sorts, counts and pages. A read returns exactly the rows and
columns its caller uses.

- Columns a caller filters, sorts or joins on are real columns with indexes. JSON
  documents hold cold detail and are read by id, one at a time.
- Every list read has `LIMIT` and a cursor (`rowid` or a sort key). No unbounded
  `.all()` over a table that grows with history.
- Existence and aggregate questions are SQL (`EXISTS`, `COUNT`, `MAX`), never "load
  everything, test in JavaScript".
- Parse a document once at the boundary where it enters, validate it then, and store
  the fields callers need as columns. Reads of trusted rows do not re-run zod.

### 2. Store derived views; update them incrementally

Anything shown or decided from history is a projection table, kept current as data
changes. Nothing rebuilds a view from all history on read.

```
 writer transaction ──► source rows ──► projection rows (same transaction)
                                    └─► observation_revisions += 1
 or
 fold(watermark) ──► rows with rowid > watermark ──► projection rows, watermark := max(rowid)
```

- Prefer updating the projection in the writer's transaction. Use a watermark fold when
  the writer cannot know the projection (for example host events).
- A projection is rebuilt from scratch only by an explicit migration, never by a timer.
- Append-only histories are child rows (one row per receipt, per event id), not arrays
  rewritten inside a parent document. Summaries (count, first, last, latest outcome)
  are columns on the parent.

### 3. Do nothing when nothing changed

Every reader checks a cheap stamp before reading.

- LAZERS data: `observation_revisions` per project. A scan, snapshot or projection read
  returns its last result when the revision has not moved.
- Host data: a session's `time.updated` and the last message cursor seen. Unchanged
  stamp → no host read.
- Timers wake only to check stamps. Work is driven by events and stamp changes, not by
  rotation through history.

### 4. Mirror the host by cursor

LAZERS keeps only the facts it derives from OpenCode sessions, plus a cursor per
session.

- New messages arrive by `message.list({ sessionID, cursor, order: "asc", limit })`
  after the stored cursor, a page at a time, then the cursor advances.
- `session.context` is read only to build a model prompt (the Architect's context),
  never for observation, progress or review.
- The latest turn is one `message.list({ order: "desc", limit: 1 })`
  (`runner/native-input.ts` already does this).

### 5. One owner per project per process

Timers, event subscriptions, change publishers, caches, recorders and workers belong to
the project's LAZERS core (`core/registry.ts`, `acquireCore`), which is already one per
project per process and generation-keyed. Module scope and per-plugin-copy instances
hold nothing that grows.

- Every plugin copy holds a host event subscription, and one hub fans each event out to the
  project cores once (`core/event-hub.ts`). A pair of subscriptions from two locations exists
  behind `LAZERS_NATIVE_EVENT_PAIR=1`, off by default: an event that reaches only locations
  outside the pair is invisible to it, so the pair cannot detect that loss itself. In the
  default mode the hub records the evidence: per first-seen event, whether every subscribed
  location delivered it (`fullyDelivered`) or some did not (`partiallyDelivered`, with a
  byte-budgeted sample of type, delivering and subscribed locations), reported by the heap
  sampler. A pair is safe only if `partiallyDelivered` stays 0 over a long session with many
  copies.
- A cache has one byte budget per process, a measurement beside its constant, and
  evicts least recently used entries. It never refuses work.
- Worker threads are per process (or per database), not per location, and receive ids
  and cursors, not whole documents.

### 6. Stream to consumers

Panels and tools receive deltas since a cursor, not whole snapshots.

- RPC reads take a cursor (`revision` or row key) and return changes since it, paged.
- Tool results return summaries and ids; full documents are fetched by id on request
  or written to a file and referenced by path.

### 7. Keep only what has a reader

Each table states its lifecycle: what reads it, and when its rows are dead (plan
integrated and past the review window, snapshot superseded by two newer generations,
transition folded into a projection). A retention pass deletes or compacts dead rows
and reports bytes reclaimed.

### 8. Budget and measure

- `diagnostics/heap.on` writes `heap.jsonl` (heap size, object counts by type, RSS,
  external memory) every minute.
- Each fix states before and after numbers: rows read, bytes parsed, heap, and the
  service footprint over a working day.
- A behavior test per hot path asserts that an idle tick reads no history (counting
  rows returned and host reads with a seeded store and fake host).
- A source check fails on new `SELECT *` or unbounded `.all()` against history tables
  outside migrations.

## Models valuation by session

A decision snapshot values every retained step and usage-snapshot fact. Facts and tasks
are already stored projections; the valuation over them is still rebuilt whole after each
revision. It is made incremental by session.

- **Unit.** One worker session. Every quantity the valuation derives from facts (usage
  selection, route evidence, cost evidence, per-call usage rows, route candidates) is a
  function of that session's facts alone; attempts only select and label. The _fact
  digest_ of a session is that attempt-independent reduction; per-session results that
  also read the session's attempts are memoized on the digest, keyed by a hash of those
  attempts.
- **Stored.** `model_decision_progress` gains `session_id` (indexed with `seq`; a partial
  index lists the few flagged rows). A small table
  `model_decision_session(project, session_id, changed)` holds a per-project change clock:
  a fold that writes or removes a fact, or folds a task that owns facts, stamps the
  affected sessions with the next clock value in the same transaction. A read asks only for
  sessions with `changed` above the clock it last saw (O(changed), not O(facts)) and reads
  the facts of exactly those sessions through the index, joined to plans and tasks as
  before. Rows the fold has not reached (queued rows, rows above the watermark, tasks
  entering or leaving) are read live and their sessions are keyed by the content read, so
  the facts are the same however far the fold lags. Digests are _not_ stored: they live in a
  process-wide LRU bounded by a byte budget (`LAZERS_DECISION_DIGEST_MB`, default 96 MiB,
  about 0.85 KiB per fact measured); a miss re-reads that one session and nothing is
  refused. After a restart the cache is cold and one pass reads every session once, then
  reads are incremental again. Existing rows get their session from a paged backfill in the
  fold; until it finishes, reads use the full path. The schema installer reruns on a
  generation change, so a plugin reload upgrades as a restart does.
- **Composition.** Totals are recomposed from per-session pieces by the same fold the full
  rebuild used, over the same sorted session order: category sums add the same numbers in
  the same order (IEEE results are bit-identical, nothing is reassociated), costs and
  market values are exact decimals, per-call rows are merged by the global fact sequence
  they were first seen at, and route candidates are replayed by sequence. Price changes
  recompute the market value of every session from the stored usage pieces without
  touching facts. If a refactor ever changes a total, the parity tests (golden hashes
  taken on the pre-change code, plus full-versus-incremental equality) fail.
- **Cost.** Reads: facts of changed sessions only. Compute: digests of changed sessions,
  then O(sessions + attempts) arithmetic to recompose. An unchanged revision still reads
  nothing (the snapshot is returned as is).

## Applying it

The lanes in `.agents/plans/memory-audit.md` implement this design area by area:
progress (A), runner (B), observability, trajectory and audit (C), models and webgpu
(D), and retention (E). Shared pieces come first so every lane uses the same ones:

1. **Project-owned resources:** register timers, subscriptions, caches and workers on
   the project core, not module scope.
2. **Stamp gate:** a helper that runs a read only when `observation_revisions` (or a
   host stamp) moved, and returns the cached result otherwise.
3. **Host cursor mirror:** a per-session cursor table and a paged `message.list`
   reader that every host-history consumer uses instead of `session.context`.
4. **Source check:** the `SELECT *` and unbounded `.all()` check, with existing sites
   listed and burned down lane by lane.
