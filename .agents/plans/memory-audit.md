# Memory audit: compute, store, stream

Owner direction (2026-11-20): LAZERS must not need gigabytes of memory. Compute
incrementally, store results, and stream data instead of materializing whole
histories. Audit the whole app.

Observed: the OpenCode service hosting LAZERS held 7 GB RSS 55 s after boot and
reached a 25–35 GB physical footprint within hours, swapping the machine, freezing
the event loop for up to 47 s and starving test runs (WebAssembly out of memory).

Findings come from four read-only code audits (runner; progress and panels' data
side; models and webgpu; verification, audit and the rest). None is measured yet:
`diagnostics/heap.on` (merged `5dc32f3d`) records heap and native memory once the
service loads it.

## Cross-cutting causes

1. **One copy per location.** About 44 plugin copies share one process. Several
   caches, recorders, event subscribers, publishers and the Models decision worker
   exist once per copy instead of once per process or project.
2. **Whole-history reads on timers.** Progress reconstruction scans every attempt
   every 5 s and rereads one finished session's full native history per scan; the
   boot pass rereads every session. Runner ticks reload full plan bodies, attempts,
   outbox receipt histories and verification evidence.
3. **Parse everything, use a little.** Whole JSON blobs and catalogs are parsed (often
   with zod) to test one field or filter in JavaScript.
4. **Rewrite-on-append.** Receipt and event-id histories are parsed and rewritten whole
   on each append.
5. **No retention.** `tasks.sqlite` is 2.58 GB (`runner_progress` 370 MB,
   `runner_conflict_scans` 358 MB, `runner_transitions` 264 MB, `native_tool_calls`
   252 MB, `model_evidence_snapshots` 187 MB, `task_changes` 2.48 M rows).

## Lanes (disjoint files)

### A. Progress reconstruction (`src/progress/**`)

| Site                                                           | Change                                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconstruction.ts:186` boot baseline, `:207` terminal refresh | Delete the timed rotation over finished sessions. Reconstruct only active sessions at boot; a finished session is reread only when an event or its `time.updated` stamp says it changed |
| `recorder.ts:1525` `assignments()`, `:1418`                    | Filter to active attempts plus sessions whose stamp moved; parse each task spec once and cache by task id and revision; skip the scan when `observation_revisions` has not moved        |
| `native.ts:129`, `:203` `session.context`                      | Read only when the session's `time.updated` changed since the last reconcile stamp                                                                                                      |
| `recorder.ts:2260`, `:2296` stamp maps                         | Diff by message count and update time; keep stamps in SQL, not per-recorder maps                                                                                                        |
| `native.ts:434` subscriber, recorder per copy                  | One subscriber and one recorder per project per process (globalThis, generation-keyed)                                                                                                  |
| `recorder.ts:1668`, `:1812` event-id arrays                    | Stop rewriting growing JSON arrays on every dedupe hit                                                                                                                                  |

### B. Runner per-tick reads (`src/runner/**`)

| Site                                                                | Change                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `recovery-bundle.ts:509`, `:372`                                    | Select ids and states only; compute `checksPassed` in SQL or from a stored verdict |
| `store.ts:2836` `outboxForDelivery`                                 | Do not select receipt history; page pending rows                                   |
| `store.ts:1237` `runnablePlans`                                     | Select scheduling columns only; load a body on demand                              |
| `attempt-advance.ts:131`                                            | Latest attempt per task in SQL                                                     |
| `store.ts:2898` `activity()`                                        | Push predicates into SQL (`EXISTS`, `event IN`)                                    |
| `store.ts:423`, `:440`, `:2873` receipt appends                     | Append-only child rows or a folded summary, never parse-and-rewrite                |
| `native.ts:756` `session(..., {messages: true})` (about 20 callers) | Read the latest turn by page; never read a conversation twice per call             |
| `verification-activities.ts:21`                                     | Drop full results after the journal write                                          |
| `attempt-advance.ts:129`, `architect-sources.ts:67`                 | Delete per-attempt and per-session entries when they settle                        |

### C. Observability, trajectory and audit data side (`src/observability/**`, `src/trajectory/**` except the panel UI, `src/audit/**`, `src/recovery/detector.ts`)

| Site                                                    | Change                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `observability/read.ts:1973` two 128 MB caches per copy | One process-wide cache per project with one byte budget                     |
| `observability/rpc.ts:111`, `:487`                      | One publisher and one event subscription per project per process            |
| `observability/read.ts:236`                             | Topology without plan bodies; gate on the observation stamp                 |
| `trajectory/read.ts:960`                                | One SQL join filtered by task instead of N+1 over every plan                |
| `trajectory/history.ts:156`, `live.ts:46`               | Store serialized pages once; no `structuredClone` plus restringify per read |
| `audit/fallow-threads.ts` `single()`                    | Compile `fallow.wasm` once                                                  |
| `audit/fallow-wasi.ts:569`                              | Reuse one shared memory per worker instead of a 4 GiB reservation per run   |
| `audit/fallow-wasi.ts:635`, `history.ts:346`, `:455`    | Parse a report once; findings index table; existence checks in SQL          |
| `recovery/detector.ts:322`                              | Filter open concerns by task in SQL                                         |

### D. Models and webgpu (`src/models/**`, `src/webgpu/**`) — owned by the Models session

| Site                                                | Change                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `decision-worker.ts`, `index.ts:134`                | One decision worker per database, not per location; no boot storm; warm only while a panel is open      |
| `server.ts:364`, `decision-worker-client.ts:70`     | Do not rebuild and structured-clone the full price state per request; key by snapshot id and generation |
| `source-store.ts:685`, `current-price-index.ts:395` | Memoize parsed snapshots by immutable id; identity by snapshot id, not canonicalized bodies             |
| `decision-read.ts:55`                               | Keep projections, not evidence inputs, in the snapshot cache                                            |
| `observation-ledger-read.ts:2399`, `:691`, `:426`   | Incremental projection from a revision watermark; no N+1 classification reads                           |
| `source-store.ts:351`                               | Prune old evidence snapshots                                                                            |
| `webgpu/features.ts:4`                              | Finite idle timeout for resident weights                                                                |

### E. Retention (after A–D)

Prune or compact the large tables above with the same lifecycle rules as the rows
they describe; measure on-disk size before and after.

## Rules for every lane

- Caches are bounded by a tunable byte budget or LRU with a measurement beside the
  constant; nothing refuses work.
- Workflow states stay in XState `lifecycleMachines`.
- Measure before and after: `heap.jsonl`, vmmap physical footprint, stall totals.
