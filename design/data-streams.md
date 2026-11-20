# Data streams: one way to read, off the main thread

Status: draft for review (2026-11-20). Extends [data handling](data-handling.md),
principle 6 ("stream to consumers").

## Intent

LAZERS has three linked problems: synchronous database calls block the plugin's main
thread, consumers receive whole snapshots instead of the part they show, and reads
produce garbage on the heap that also runs host hooks and tools. This design gives
every consumer one way to read data: a cursor-driven stream over a sliding window of
items, served by read workers, with caching inside the stream.

## Goals

- One API shape for every read that shows data: panels, detail panes, agent tools,
  reports and folds.
- The consumer states its window in **items**, from what its view needs (for example
  50 in view plus 25 of slop each side is a window of 100).
- The window is the only copy a consumer needs. A consumer never builds its own cache.
- Show reads never run on the main thread.
- Row and parse garbage is produced in worker heaps. Transport buffers are pooled and
  go back to the worker that allocated them.
- Memory is bounded by construction: open streams × window.

## Non-goals

- Moving write transactions or workflow decisions off the main thread (see
  "Threads").
- A byte budget in the consumer contract. Bytes exist only inside the transport.
- A general SQL surface. A stream reads a named source.

## Anti-goals

- A second read path beside streams for "small" or "quick" reads that show data.
- A cap that refuses or truncates a read. A window slides; nothing is refused.
- A consumer that holds rows outside its stream.

## Threads

```
main thread (one writer)                       read workers (read-only connections)
  host hooks, tools, timers, XState
  decide reads + write transactions  ──commit──► revision stamp
  stream client: one window frame    ◄─ frame ── source query ► write the frame
                                     (shared memory, else transfer, else copy)
```

| Read kind | Example                                           | Where it runs                           |
| --------- | ------------------------------------------------- | --------------------------------------- |
| Decide    | A tick reads plan state, then writes a transition | Main thread, in the write's transaction |
| Show      | Panels, tool results, reports, Models, trajectory | Read workers, as streams                |

- Writes stay synchronous on the main thread. One writer means no write races, XState
  transitions keep their transactions, and the change hooks on the main connection
  (`src/database-events.ts`) keep working.
- A decide read is an indexed point read inside or just before its write. It never
  pages history. The unbounded-read check already enforces this.
- Read workers open read-only connections. In WAL mode a read that starts after a
  commit sees that commit, so a stream is at most one message behind the writer. There
  are no torn reads.
- A timing probe on `read` and `atomic` in `src/storage.ts` records synchronous time
  per call site. If write time shows up as stalls, heavy writers (retention, backfills,
  folds) are the first candidates for a writer worker. That is a later decision made
  from those numbers.

## The stream contract

```ts
const stream = data.open("runner.plans", {
  filter: { project, state: "active" },
  order: "updated desc",
  window: 100, // items, slop included; the consumer decides
  anchor: "head", // or a row key
});

stream.items; // at most `window` keyed rows, in order, read from the frame
stream.before; // rows outside the window toward the start
stream.after; // rows outside the window toward the end
stream.revision; // the database revision the window reflects
stream.slide(+25); // move the window by items
stream.seek(key); // jump; the window refills around the key
stream.on("change", listener); // items in the window changed
stream.close(); // the buffer goes back to its worker
```

| Consumer             | Use                                                      |
| -------------------- | -------------------------------------------------------- |
| Panel list           | `window` from the view; `slide` on scroll                |
| Detail pane          | `anchor: key, window: 1`; the source carries cold fields |
| Agent tool           | Read one window; return a continue marker (the edge key) |
| Report, fold, export | `slide` to the end with a working window                 |

Rules:

1. **Keys.** Every source declares a stable row key and a total order. The cursor is
   the order key of a window edge, never an offset.
2. **Anchoring.** The window is anchored to row keys. A changed row updates in place.
   Rows added or removed outside the window change only `before` and `after`.
3. **Following.** A stream anchored at `head` (or `tail`) follows new rows.
4. **Sources.** A source is a named query registered once: key, order, filterable
   columns, the columns a list row carries, and the cold fields a detail row adds.
   List rows carry only what a list shows.
5. **Counts.** `before` and `after` come from an indexed count or a stored counter.
   A source that cannot count cheaply reports "more" instead of a number.

## The window is the cache

There is no cache beside the window. The consumer's window already includes the slop
its view needs (50 in view plus 25 each side is a window of 100), and the window lives
in a buffer the stream owns. Scrolling inside the slop reads memory that is already
there. `slide` and `seek` ask the reader to bring the buffer to the new position.

```
  not held │              window = 100 items, one frame              │ not held
  ─────────┼──────────────────────────────────────────────────────────┼─────────
           │  slop 25  │           view 50           │  slop 25      │
```

- Bound per stream: one window (two frames of it in shared memory, see below). Bound
  per process: the sum over open streams. A closed stream holds nothing.
- Rows are read from the frame by field, on access. Nothing is decoded into objects
  until a consumer reads it, and text is decoded only for the fields shown.
- A change to a row in the window rewrites the frame; the stream then emits `change`.

## Transport: three tiers, one contract

The stream picks the best tier the two ends support. The consumer sees the same
contract on all three.

| Tier | Used when                                   | How the window moves                                                              |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | Shared memory is available (same process)   | The reader writes the frame in a shared buffer and signals with Atomics           |
| 2    | Transfer is available, shared memory is not | The reader fills a pooled buffer and transfers it; the consumer transfers it back |
| 3    | Neither (plugin RPC to the GUI process)     | The frame's bytes are copied into the message                                     |

Tier 1, shared memory:

```
  shared buffer:  [ header | frame A | frame B ]
  header: active frame index, revision, item count, sequence   (Int32, Atomics)

  reader worker:  write the inactive frame ─► Atomics.store(active) ─► Atomics.notify
  consumer:       Atomics.waitAsync(sequence) ─► read the active frame
```

- Two frames, so the consumer always reads a complete window while the reader writes
  the next one. The reader flips the active index in one atomic store.
- The consumer never blocks: it waits with `Atomics.waitAsync` (as
  `src/audit/fallow-wasi.ts` does today). `Atomics.wait` is never called on the main
  thread.
- A slide reuses the rows that stay: the reader copies them between frames inside the
  worker and reads only the new edge from the database.
- If a window's rows outgrow the buffer, the reader allocates a larger one and hands it
  over. The consumer sees nothing but a later `change`. Nothing is refused.

Tier 2, transfer:

- Buffers come from the reader worker's pool and cross by transfer, never by copy.
- When the consumer slides or closes, it transfers the buffer back to the worker that
  allocated it. That worker reuses it. No other thread frees it.

Tier 3, copy:

- The same frame layout travels as message bytes. This is the tier for the GUI process,
  which shares no memory with the server.

The frame layout is the same on every tier, so one decoder serves all three.

### Measured on Bun 1.4.4 (2026-11-20)

A throwaway spike read 500-row pages (about 0.7 MB each) from a 200,000-row table.
Medians of 5 runs on a loaded machine.

| Variant                                | Pages/s | Main heap growth | Buffers allocated per 100 pages |
| -------------------------------------- | ------- | ---------------- | ------------------------------- |
| Main thread `.all()` and parse (today) | 1,181   | +8 MB            | none                            |
| Worker, structured clone               | 627     | +7 MB            | none                            |
| Worker, transfer                       | 741     | +17 MB peak      | 100                             |
| Worker, transfer with a returned pool  | 742     | +8 MB            | 2 to 3 (97-99% reuse)           |
| Worker, shared memory                  | 622     | about 0          | 0                               |

What the numbers decide:

- A worker costs 30-50% of raw page throughput. It is chosen for the event loop, not
  for speed: a 2-second synchronous query, allocation or collection storm in a worker
  moved the main thread by at most 2.8 ms, which is the idle noise floor.
- Shared memory is the only variant that does not grow the main heap. Text decodes
  directly from a shared buffer in this Bun; no copy is needed.
- Transfer beats clone by 15-25%. A buffer transferred back is detached on the sender
  and usable again in the worker. The pool changes allocation count, not speed.
- Keep one request in flight ahead of the consumer (depth 2). Depth 1 loses 25-45%;
  depth 3 gains nothing.
- Read rows with `.values()` or `.all()`. `.raw()` was the slowest source by 30-70%.
- A worker inside a synchronous loop answers no messages. Every wait is interruptible
  through shared memory, every worker has an `error` listener, and a worker closes its
  database before it is terminated.

## Across the GUI boundary

Panels reach the server through plugin RPC, which already carries cursors and
revisions. The GUI side uses the same stream client on the copy tier. The contract
(`open`, `slide`, `seek`, `change`, `close`, window in items) is identical on both
sides.

## Approaches considered

| Approach                                     | Trade-off                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Whole project core in a worker               | Removes all blocking, writes included. Every host call needs a proxy; every state machine crosses a thread. |
| Named operations in one database worker      | All 577 call sites become async; transactions that mix logic and SQL must be rewritten as single commands.  |
| **Read workers for show reads; writes stay** | Chosen. No write races, state machines unchanged, show reads and their garbage leave the main thread.       |

The stream contract is the boundary in all three, so the chosen approach does not rule
out moving the core later.

## Left to the builder

- The frame layout and the source registration API.
- Worker count and how streams are assigned to workers.
- The order sources migrate in (observability, models, tasks, projects and trajectory
  hold most show reads today).

## Open

- Whether any write path needs a worker, from the `read`/`atomic` timing probe.
