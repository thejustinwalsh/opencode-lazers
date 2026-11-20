# Data Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read that shows data goes through one stream API: a window of items in a
buffer, served by read workers, moved by shared memory, else transfer, else copy.

**Architecture:** Writes and decide reads stay synchronous on the main thread. Show reads
run in read workers on read-only connections. A stream is one frame of `window` items;
the reader rewrites the frame on `slide`, `seek` and data change. The GUI uses the same
client over plugin RPC (copy tier).

**Tech Stack:** TypeScript (strict), Bun 1.4.4, `bun:sqlite`, `node:worker_threads`,
`SharedArrayBuffer` + `Atomics`, SolidJS, OpenCode plugin RPC.

**Spec:** [design/data-streams.md](../../design/data-streams.md) (read it first), with
[design/data-handling.md](../../design/data-handling.md).

## Global Constraints

- The window is stated in items. No byte budget, row cap or refusal appears in the
  consumer contract. A read never fails or truncates because of size.
- Show reads never run on the main thread once their source is migrated.
- Writes stay on the main thread; workers open the database read-only
  (`acquireSharedConnection(path, "readonly")` as `src/models/decision-worker.ts:102`).
- `Atomics.wait` is never called on the main thread; use `Atomics.waitAsync`.
- A buffer is returned to, and freed only by, the worker that allocated it.
- Every worker: an `error` listener on the parent, closes its database before
  `terminate()`, every wait interruptible by a shared stop flag.
- New worker scripts are added to `scripts/build-server.ts` and spawned via `workerURL`.
- Workers and pools are owned by the project core / process registry
  (`src/core/registry.ts`, `src/core/process-shared.ts`), one reader pool per database
  per process. Nothing grows at module scope.
- Read rows with `.values()` or `.all()`, not `.raw()`.
- Tests: `bun test --timeout 120000 <files>`; `bun run verify` before each commit.
- Atomic Conventional Commits, configured identity, no AI attribution, signing on.
- Work in a worktree under `.claude/worktrees/`; never build in the main checkout; never
  open the live `tasks.sqlite`.

## Review Focus

1. A consumer reads while the reader rewrites the frame: it must see the old complete
   window or the new one, never a mix (Task 5 test).
2. A row larger than the current buffer (a 5 MiB document in a `window: 1` detail read):
   the stream grows its buffer and delivers it (Task 5 test).
3. A row inside the window changes or is deleted between slides: the window updates in
   place and `before`/`after` stay correct (Task 6 test).
4. A consumer that never calls `close()` (panel torn down, tool aborted): the stream is
   closed when its owner scope ends and its buffer returns to the pool (Task 5 test).
5. A reader worker dies mid-read: open streams reopen on a new worker at their current
   anchor; nothing hangs (Task 4 test).

## File Structure

| File                                | Responsibility                                                             |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `src/streams/frame.ts`              | Frame layout: encode rows into a buffer, read fields lazily                |
| `src/streams/source.ts`             | `defineSource`, the source registry, keyset SQL for a window               |
| `src/streams/sources/*.ts`          | One file per registered source                                             |
| `src/streams/reader-worker.ts`      | Worker: read-only connection, runs sources, writes frames, buffer pool     |
| `src/streams/protocol.ts`           | Messages between client and reader                                         |
| `src/streams/client.ts`             | `openStream`: tiers, window state, `slide`/`seek`/`change`/`close`         |
| `src/streams/pool.ts`               | Reader pool per database per process, stream-to-worker assignment, restart |
| `src/streams/rpc.ts`                | Plugin RPC contract and server handlers for the copy tier                  |
| `src/streams/gui.ts`                | GUI client over RPC; `createStream` for SolidJS                            |
| `src/diagnostics/storage-timing.ts` | Synchronous time per `read`/`atomic` call site                             |

---

### Task 1: Spawn the transition index worker after the commit

**Files:** Modify `src/runner/store.ts` (near 1506), `src/runner/transition-indexes.ts`;
test `src/runner/transition-indexes.test.ts` (create or extend).

- [ ] Test: with a fake `onSpawn`, assert the worker is spawned only after the
      `atomic` that requested it has returned (`db.inTransaction === false` at spawn).
- [ ] Run it; expect FAIL (spawn happens inside the transaction).
- [ ] Change `ensureTransitionIndexes` so the transaction only records that indexes are
      needed and the caller spawns after `atomic` returns.
- [ ] Run the test and `src/runner/store*.test.ts`; expect PASS.
- [ ] Commit `fix(runner): spawn the transition index worker after its transaction commits`.

### Task 2: Time synchronous database work per call site

**Files:** Create `src/diagnostics/storage-timing.ts` and its test; modify
`src/storage.ts` (`read`, `atomic`, `retryBusy`), `src/diagnostics/heap-sampler.ts`.

**Interfaces — Produces:**

```ts
export type StorageTiming = {
  site: string
  kind: "read" | "atomic"
  count: number
  totalMs: number
  maxMs: number
}
export function timeStorage<T>(kind: "read" | "atomic", run: () => T): T // records under the caller's site
export function drainStorageTiming(top: number): StorageTiming[] // top sites by totalMs since last drain
```

- `site` is `file:line` of the first stack frame outside `src/storage.ts`, resolved only
  when a call exceeds 2 ms (cheap path: a counter and `performance.now()` pair). Sites
  are kept in a map bounded by evicting the smallest `totalMs` entry beyond 512 sites.
- Active only when `diagnostics/heap.on` exists (same flag as the heap sampler).
- The heap sampler writes `storage: drainStorageTiming(20)` plus total sync ms into each
  `heap.jsonl` line.

- [ ] Test: a 20 ms busy loop inside `repository.read` is reported under this test
      file's site with `kind: "read"`, `count: 1`, `maxMs >= 20`; a 0.1 ms read adds to
      totals without resolving a site.
- [ ] Test: with the flag absent, `drainStorageTiming` returns `[]`.
- [ ] Implement; run tests; `bun run verify`.
- [ ] Commit `feat(diagnostics): time synchronous database work per call site`.

### Task 3: Frame codec

**Files:** Create `src/streams/frame.ts`, `src/streams/frame.test.ts`.

**Interfaces — Produces:**

```ts
export type ColumnType = "int" | "float" | "text" | "json" | "bool" // nullable always allowed
export type Columns = Readonly<Record<string, ColumnType>>
export type FrameHeader = {
  revision: number
  count: number
  before: number | "more"
  after: number | "more"
}

/** Bytes needed for `rows`; exact. */
export function frameSize(columns: Columns, rows: readonly unknown[][]): number
/** Writes header + rows at `offset`; throws RangeError if it does not fit (callers size first). */
export function writeFrame(
  target: ArrayBufferLike,
  offset: number,
  columns: Columns,
  header: FrameHeader,
  rows: readonly unknown[][],
): number
/** Zero-copy reader. `row(i)` returns an object whose getters decode one field on access. */
export function readFrame<C extends Columns>(
  source: ArrayBufferLike,
  offset: number,
  columns: C,
): {
  header: FrameHeader
  row(index: number): { readonly [K in keyof C]: unknown }
  key(index: number, keyColumns: readonly (keyof C)[]): string
}
```

- Little endian. Frame: `u32 count | u32 usedBytes | f64 revision | f64 before | f64 after`
  (`-1` encodes `"more"`), then a `u32` row-offset table, then rows. Row: one null bitmap,
  fixed 8-byte slots for `int`/`float`/`bool`, `u32 length + UTF-8 bytes` for `text` and
  `json`. `json` is stored as text and parsed on access, once, memoized per row object.
- Works identically over `ArrayBuffer` and `SharedArrayBuffer`.

- [ ] Tests: round trip of every type incl. null, multi-byte text, a 5 MiB text field,
      empty frame; `frameSize` equals bytes written; reading one field of a row does not
      decode the others (spy on `TextDecoder.prototype.decode` call count); same results
      over a `SharedArrayBuffer`.
- [ ] Implement; run; verify; commit `feat(streams): frame codec with lazy field reads`.

### Task 4: Sources and the reader worker

**Files:** Create `src/streams/source.ts`, `src/streams/protocol.ts`,
`src/streams/reader-worker.ts`, `src/streams/pool.ts`, tests beside each; modify
`scripts/build-server.ts`, `src/core/server-bundle.test.ts` (expect `reader-worker.js`).

**Interfaces — Consumes:** Task 3. **Produces:**

```ts
export type SourceDefinition<F, C extends Columns> = {
  name: string // "tasks.list"
  table: string // FROM clause (table or view)
  key: readonly (keyof C & string)[] // stable row key
  orders: Readonly<Record<string, readonly { column: string; direction: "asc" | "desc" }[]>> // each ends with the key
  filter(input: F): {
    where: string
    params: readonly (string | number | null)[]
  } // indexed columns only
  columns: C // list row
  detail?: Columns // cold fields added when window === 1
  count: "exact" | "more" // "exact" requires an indexed count
}
export function defineSource<F, C extends Columns>(definition: SourceDefinition<F, C>): Source<F, C>
export function windowQuery(
  source: Source<any, any>,
  input: {
    filter: unknown
    order: string
    anchor: "head" | "tail" | { key: readonly unknown[] }
    window: number
  },
): { rows: SQL; before: SQL; after: SQL }

// protocol.ts
export type ToReader =
  | {
      type: "open"
      stream: number
      source: string
      filter: unknown
      order: string
      anchor: Anchor
      window: number
      tier: "shared" | "transfer" | "copy"
    }
  | { type: "slide"; stream: number; delta: number }
  | { type: "seek"; stream: number; anchor: Anchor }
  | { type: "revision"; revision: number } // main thread committed; refresh affected streams
  | { type: "return"; buffer: ArrayBuffer } // transfer tier: buffer goes home
  | { type: "close"; stream: number }
export type FromReader =
  | { type: "opened"; stream: number; shared?: SharedArrayBuffer }
  | {
      type: "frame"
      stream: number
      buffer?: ArrayBuffer
      bytes?: Uint8Array
      sequence: number
    }
  | { type: "regrow"; stream: number; shared: SharedArrayBuffer }
  | { type: "failed"; stream: number; message: string }

// pool.ts
export function readerPool(databasePath: string): ReaderPool // one per database per process
```

- The reader keeps per stream: source, filter, order, the keys of the window's two
  edges. `slide(delta)` reads only `|delta|` new rows by keyset from the leading edge
  and reuses the retained rows from the current frame.
- Shared tier header (Int32Array at offset 0): `[active, sequence, stop, frameBytes]`.
  The reader writes the inactive frame, stores `active`, increments `sequence`,
  `Atomics.notify`. If rows need more than `frameBytes`, it allocates a larger shared
  buffer and sends `regrow`.
- Transfer tier: buffers from a per-worker pool; `return` puts a buffer back.
- On `revision`, the reader re-reads only streams whose source table changed (the
  message carries no table list in v1: re-run each open stream's window query and send
  a frame only if its bytes differ).
- Pool: 2 workers by default (`LAZERS_STREAM_READERS`), streams assigned round-robin;
  a worker `error`/exit reopens its streams on a fresh worker at their current anchor.

- [ ] Tests (seeded temp database, a test source over a 10,000-row table):
      `open` at head returns the first `window` rows and exact `before`/`after`;
      `slide(+25)` returns rows 25..124 and the worker read 25 rows (count statements);
      `seek(key)` centres the window on the key; a detail open (`window: 1`) carries
      `detail` columns; all three tiers produce byte-identical frames; a returned
      transfer buffer is reused (allocated count stays ≤ 3 over 100 slides); killing the
      worker mid-stream yields a new frame at the same anchor from a new worker.
- [ ] Bundle test: `dist/reader-worker.js` exists and answers an `open`.
- [ ] Implement; run; verify; commit `feat(streams): sources and the reader worker pool`.

### Task 5: The stream client

**Files:** Create `src/streams/client.ts`, `src/streams/client.test.ts`.

**Interfaces — Consumes:** Tasks 3, 4. **Produces:**

```ts
export type StreamOptions<F> = {
  filter: F
  order: string
  window: number
  anchor?: "head" | "tail" | { key: readonly unknown[] }
}
export type Stream<C extends Columns> = {
  readonly items: readonly { readonly [K in keyof C]: unknown }[] // lazy rows over the frame
  readonly before: number | "more"
  readonly after: number | "more"
  readonly revision: number
  ready(): Promise<void> // first frame
  slide(delta: number): Promise<void>
  seek(anchor: "head" | "tail" | { key: readonly unknown[] }): Promise<void>
  on(event: "change", listener: () => void): () => void
  close(): void
  [Symbol.dispose](): void
}
export function openStream<F, C extends Columns>(
  pool: ReaderPool,
  source: Source<F, C>,
  options: StreamOptions<F>,
  owner?: { onDispose(run: () => void): void },
): Stream<C>
```

- Tier choice: shared if `typeof SharedArrayBuffer === "function"` and the pool is
  in-process; else transfer; copy only over RPC (Task 7).
- Shared tier reads: load `sequence`, read the active frame, re-check `sequence`
  unchanged or retry. Wait for the next frame with `Atomics.waitAsync`.
- `items` objects are valid until the next frame; `change` fires after each new frame.
- `owner` ties the stream to a scope (project core, RPC subscription, tool call); when
  the scope ends the stream closes.

- [ ] Tests: Review Focus 1 (a reader loop flipping frames 10,000 times while the
      client reads: every read is one complete window), 2 (5 MiB row through `regrow`),
      4 (owner disposed → buffer back in the pool, `close` idempotent); `slide` inside
      the same window issues one message; anchored at `head`, an insert on the main
      connection plus `revision` produces `change` with the new row first.
- [ ] Implement; run; verify; commit `feat(streams): stream client with shared, transfer and copy tiers`.

### Task 6: Revisions from the writer

**Files:** Modify `src/database-events.ts` (or the revision publisher it feeds),
`src/streams/pool.ts`; test `src/streams/revision.test.ts`.

- After each committed write the existing change tracking fires; the pool sends one
  coalesced `revision` message per event-loop turn to its workers.
- [ ] Tests: Review Focus 3 (update and delete of a row inside the window: in-place
      update, `after` decremented, no window jump); 100 writes in one turn send one
      `revision`; a write to an unrelated table produces no `frame` message.
- [ ] Implement; run; verify; commit `feat(streams): writer revisions refresh open streams`.

### Task 7: The GUI over RPC (copy tier)

**Files:** Create `src/streams/rpc.ts`, `src/streams/gui.ts`, tests; register in
`src/index.ts` beside the other `timedRpc(ctx.rpc).register` calls.

**Interfaces — Produces:**

```ts
// one RPC namespace for every source
Streams.open({ source, filter, order, window, anchor }) -> { stream, frame: Uint8Array }
Streams.slide({ stream, delta }) -> { frame }
Streams.seek({ stream, anchor }) -> { frame }
Streams.close({ stream })
Streams.events "frame" { stream, frame } // pushed on change
// gui.ts
export function createStream<F, C extends Columns>(source: SourceRef<F, C>, options: () => StreamOptions<F>): { items: Accessor<...>; before: Accessor<...>; after: Accessor<...>; slide(delta: number): void; seek(anchor): void }
```

- Server side each RPC stream wraps an `openStream` owned by the RPC subscription; a
  dropped subscription closes it.
- `createStream` reopens when `options()` changes and closes on cleanup.
- [ ] Tests: server handler round trip against a seeded database; a dropped
      subscription returns the buffer to the pool; DOM test: a list of 50 visible rows
      with `window: 100` renders, and scrolling by 25 calls `slide(25)` once.
- [ ] Implement; build GUI in the worktree; verify; commit
      `feat(streams): stream RPC and the SolidJS stream client`.

### Task 8: First source end to end — the Tasks list

**Files:** Create `src/streams/sources/tasks.ts`; modify `src/tasks/rpc.ts`,
`src/tasks/read.ts`, the Tasks panel list component, `scripts/unbounded-reads.allowlist`.

- [ ] Define `tasks.list` (columns the list shows) and its detail columns; parity test
      against the existing `Tasks.query` results for the fixtures in `test/tasks*`.
- [ ] Read-meter test: opening the panel and scrolling runs 0 statements on the main
      connection.
- [ ] Switch the panel list to `createStream`; delete the replaced query path and its
      cache.
- [ ] Verify; commit `feat(tasks): the Tasks list reads through a stream`.

### Task 9: Migrate the remaining show reads, one lane each

Same recipe as Task 8 (source, parity test, read-meter test, switch, delete the old
path). Lanes: observability (snapshot, radar, live, trajectory), models, projects and
planning, agent tools (`lz-*` list and report tools read one window and return the edge
key as the continue marker). A final commit adds a source check: a show-read entry point
(RPC handler or tool `execute`) that calls `repository.read` fails `bun run verify`,
with remaining sites listed in an allowlist and burned down.

#### Migration recipe

Learned migrating the first sources (`tasks.list`, the agent task tools). Follow it for each
panel or tool.

1. **List the reads and the fields.** For the panel or tool, list every RPC method and
   statement it uses and every field its rows render. For each field decide: a SQL column of
   tables the reader can read (go), a value built from main-thread memory or an in-process
   projection (not a column: it needs a stored projection written in the writer's
   transaction first), or a TypeScript derivation of columns (compute it in the consumer
   from the columns, or add a column).
2. **Define the source** in `src/streams/sources/<name>.ts` with `defineSource`: `table`
   (a table, a view, or an aliased subquery), `tables` naming every table read (a write to
   one refreshes the stream), `key`, `orders` that end with the key and use list columns
   only, a `filter` over index-backed columns, `columns`, `detail` for a detail pane.
   Leave `count` at the default probe unless a stored counter exists. Import the file in
   `src/streams/sources/index.ts`. Never accept free text, JSON-path or session filters
   that have no index; list them as needing an index or a stored column.
3. **Parity test** next to the source: seed the repository the old read's tests use, walk
   the stream from the head to the end by sliding, and compare ids, order and every
   SQL-derived field with the old read for every filter and order the consumer offers.
4. **Read-meter test:** wrap the main repository with `meterRepository`, open the stream,
   slide and seek, and assert `statements` is empty; assert the same meter sees the old
   path's statements so the test is not vacuous.
5. **Consumer.** Server side (tool, report, fold): `openStream(pool, source, ...)` with the
   pool from `acquireReaderPool` held by the project core, window = the tool's page size,
   read one window, return the edge key as the continue marker, close in the same call.
   GUI: `createStream(transport, sourceRef, options)` over `Streams` RPC; window from the
   view (visible rows plus slop each side), `slide` on scroll, rows keyed by the source key.
6. **Delete** the replaced read, its paging state and caches, and its
   `scripts/unbounded-reads.allowlist` entries; list remaining callers by file:line.
7. **Verify:** `bun run verify`, the new tests, the consumer's DOM or tool tests, a server
   and GUI build in the worktree. The heap sampler's `readerPools` line shows the pool
   (workers, streams, statements, buffers) in the live service.
8. **Report** each filter or order with no index, each field that blocked the migration,
   and each caller left behind.

#### Findings: the Tasks panel

The Tasks panel did not migrate in the first pass. Three things block it, and some filters
have no index.

1. **The list is a derived tree.** `src/tasks/panel.tsx` renders rows built by
   `execution-list.ts` and `virtual-rows.ts` from `Tasks.query` pages, `scheduling` pages
   (up to 1,000 plans), `topology`, current activity and dependencies, with expand and
   collapse and plan grouping. `Tasks.query` is one input; `scheduling`, `topology` and
   `currentActivity` read on the main thread too, so each needs its own source before the
   panel reads nothing there.
2. **The schedule order is not a keyset order.** `scheduledTaskPageSQL` computes `position`
   as `COUNT(*) OVER () - ROW_NUMBER() OVER (ORDER BY ...)` across the whole project (state
   rank, plan priority, plan FIFO, finish time from `runner_transitions`). A stream needs a
   stored, incrementally maintained rank, updated in the transaction that moves a node or
   plan.
3. **Fields come from main-thread state or TypeScript.** `status`, `reason`,
   `waitingOnPlans` and `startedAt` come from `effectiveExecution`, which reads in-memory
   runner reservations; `title` is `taskTitle(objective)`; `classification`, `concern`,
   `takeover` and `matches` are TypeScript derivations. Decision: no overlay; a source never
   depends on main-thread memory, so the rank, effective state, blocker reason and flags
   become a stored projection written with the runner's transition.

Filters with no index or stored column, so no source offers them: `search`
(`instr(lower(tasks.body), ...)`, a scan of bodies), `scopePath`
(`json_each(json_extract(body,'$.proposal.writeScope'))`) and `sessionID`
(`json_extract(body,'$.provenance.sessionID')`). Each needs a stored, indexed column
(session id; a normalized scope table) or a text index before it can be a filter.

The agent tools `lz-list-tasks` and `lz-query-tasks` (`src/tools.ts`) did not migrate:
both return the full `TaskSummary` (effective `status`, `reason`, `recordedState`,
`waitingOnPlans`, `startedAt`, `concern`, `takeover`, `classification`, `matches`,
`disposition`), and `lz-query-tasks` also filters by search, scope path and session and
returns `count`, `snapshot` and `stateCounts`. They wait for the stored projection.

## Order and lanes

```
Task 1 ─┐
Task 2 ─┼─ independent, start now
Task 3 ─┘──► Task 4 ──► Task 5 ──► Task 6 ──► Task 7 ──► Task 8 ──► Task 9 lanes (parallel)
```
