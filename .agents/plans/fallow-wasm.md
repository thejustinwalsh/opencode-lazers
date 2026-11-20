# Fallow and WebAssembly: memory, threads, caches and storage

Follows [data handling](../../design/data-handling.md). Facts are from a read of `main`
at `5f164872`; line numbers drift as lane C of the
[memory audit](memory-audit.md) lands.

## How a run works today

```
caller (tool, runner review, auditor report)
  └─► wasm-analyzer.ts: one Worker per process, one promise queue, timeout starts when served
        └─► fallow-worker.ts: one run at a time; Bun.gc(true) after each response
              ├─ single:   read 23.9 MB fallow.wasm + compile, every call
              └─ threaded: compiled once; new 4 GiB shared Memory per run; 2 helper Workers
                    └─ helper: new WASI + Instance per message
              stdout: Rust String ─► fd_write slices ─► Buffer.concat ─► string ─► JSON.parse
                      ─► postMessage clone ─► projection ─► JSON.stringify into audit_sections
```

## Problems

| #   | Problem                                                                           | Evidence                                                                                                                                                                                                                                                             | Effect                                                                                        |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | A new ~4 GiB shared memory per threaded run, freed only by GC                     | `fallow-wasi.ts:569`, `SHARED_MEMORY` `:231`, linker flags `build-fallow-wasm.ts:92`                                                                                                                                                                                 | Test processes run out of memory; 466–627 MB left after five runs (`fallow-memory.test.ts:5`) |
| 2   | Single-threaded module read and compiled on every call                            | `fallow-threads.ts:54`, `fallow-worker.ts:143`                                                                                                                                                                                                                       | 24 MB read plus a compile per run                                                             |
| 3   | The report is copied about eight times                                            | Rust String, `fd_write` slices, `Buffer.concat`, decode, `JSON.parse`, clone, projection, `JSON.stringify`                                                                                                                                                           | Peak memory several times the report size                                                     |
| 4   | Whole reports stored as one blob per section; every read parses all of them       | `audit_sections` 70 rows, 31 MB; `history.ts:346`, `:455`, `:490`                                                                                                                                                                                                    | `finish`, `detail` and `decide` parse every report; `list` runs N+1 queries                   |
| 5   | One unbounded queue shared by tools, runner review and background auditor reports | `wasm-analyzer.ts:215`, `verification-review.ts:477`, `report.ts:25`                                                                                                                                                                                                 | A 10-minute background section blocks verification and tools                                  |
| 6   | Any threaded error disables threads for the worker's life                         | `fallow-threads.ts:45`                                                                                                                                                                                                                                               | Silent fallback to the slower module after unrelated errors                                   |
| 7   | Duplicate whole-project work                                                      | `ls-files` only to count files (`fallow-worker.ts:201`); second `deadCode` for suppressions (`review.ts:84`); three runs for a config dry run; file-scoped tools analyze everything (`tools.ts:460`)                                                                 | Repeated full scans                                                                           |
| 8   | Cache copies up to 256 MB into the checkout after every cached run                | `fallow-cache.ts:21`, `:75`; cap stated as 128 MB (`fallow-wasi.ts:53`)                                                                                                                                                                                              | Disk churn; the copy limit is twice the cap                                                   |
| 9   | Tests run hundreds of threaded runs in one process with no pool and no collection | `test-support.ts:38`; about 140 runs in one cache test                                                                                                                                                                                                               | The whole-suite out-of-memory failures                                                        |
| 10  | Report export rewritten on every return, including replays                        | `report.ts:97`, `history.ts:531`                                                                                                                                                                                                                                     | Repeated full writes                                                                          |
| 11  | Full reports can be returned into an agent's context                              | `history.ts:483`, `tools.ts:183` (`includeReports`)                                                                                                                                                                                                                  | Unbounded tool results                                                                        |
| 12  | Cache test differs in `next_steps` after a corrupt `graph-cache.bin`              | `fallow-cache.test.ts:110`                                                                                                                                                                                                                                           | Unverified: likely the engine's cache-rejection trace feeding `next_steps`                    |
| 13  | Smaller items                                                                     | Queue poisoning if a post throws (`fallow-worker.ts:249`); up to 100 ms `Atomics.wait` per helper (`fallow-wasi.ts:207`); memory failure detected by substring (`report.ts:80`); array allocation per WASI call (`fallow-wasi.ts:523`); leaked test temp directories | Fragility and small waste                                                                     |

## Target design

1. **One engine per process, modules compiled once.** The analyzer worker holds both
   compiled modules for its life (lane C: problem 2).
2. **One shared memory per worker, reused.** The threaded run gets its memory from a
   per-worker slot. Each run resets the module state (fresh instance on the same memory,
   or the module's own reset export), and nothing else holds the memory. Measure resident
   memory after N runs; it must stay flat (lane C: problem 1). If a reset is not safe
   for the module, keep one memory per run but release it deterministically: drop every
   reference (closures, helper messages, sinks) and terminate helpers, then measure.
3. **Size memory to the work.** Replace the fixed ~4 GiB initial size with a smaller
   initial size that grows on demand, if the threaded build allows growth of shared
   memory; record the measured peak per repository size beside the constant.
4. **Stream the report out, parse once.** `fd_write` appends into one growing buffer
   (no per-call slices); the worker parses once and transfers the result rather than
   cloning a string. Only the projection the caller needs crosses back to the main
   thread; the full report goes straight to storage (lane C starts this: problem 3).
5. **Store findings as rows.** Per section, store the summary and counts as columns,
   and each finding as a row in `audit_findings` (run, analysis, finding id, path, rule,
   severity, small detail JSON), indexed by run and path. Keep the raw report only as a
   compressed file under `audits/` for export, written once per run. `finish`, `detail`,
   `decide` and `list` become SQL (lane C: the `finish`, `detail` and `decide` parts of
   problem 4; the table change follows here).
6. **Prioritized, bounded queue.** Three priorities: interactive tool calls, runner
   verification, background auditor reports. A background run yields between sections
   and is cancelled if a higher priority waits longer than its budget. The timeout covers
   queue wait plus run time (problem 5).
7. **Fail the run, not the mode.** A threaded failure disables threads only for errors
   that show threads are unsupported (no shared memory, helper spawn refused). Other
   errors fail that run and are reported (problem 6).
8. **No duplicate scans.** Count files from the engine's own walk instead of a separate
   `ls-files`; run the suppression check inside the same `deadCode` call or from its
   result; run the config dry run as one combined call; file-scoped tools pass `paths`
   (problem 7).
9. **Cache in place.** Keep the engine cache where the canonical checkout reads it,
   publish only when the cache changed (compare size and hash), and make the copy limit
   the stated 128 MB (problem 8).
10. **Tests share one engine.** Test support reuses one pool and one memory slot per
    process, and the large matrix tests run in their own process (`bun test` per file
    or a child process, as `fallow-memory.test.ts` already does). The whole suite must
    pass in one `bun test` run (problem 9).
11. **Bounded outputs.** Export once per run; `lz-get-audit` returns summaries and the
    export path, never full reports (problems 10 and 11).
12. **Pin down `next_steps`.** Reproduce the corrupt-cache difference, confirm the
    trace input, and either strip that field in the comparison with a reason or fix the
    engine output (problem 12).
13. **Small fixes.** Catch per request so one failure cannot poison the queue; replace
    the `Atomics.wait` settle with an async handshake; use typed error codes instead of
    substring matching; reuse the WASI argument buffer; clean up test temp directories
    (problem 13).

## Order

| Step | Scope                                                                                            | Owner               |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------- |
| 1    | Items 1, 2 and the first part of 4: compile once, reuse memory, parse once, SQL existence checks | Lane C, in progress |
| 2    | Item 10: tests share the engine; the whole suite passes in one process                           | Next implementer    |
| 3    | Item 5: findings table and export file; migration from existing `audit_sections`                 | Next implementer    |
| 4    | Items 6 and 7: queue priorities and failure handling                                             | Next implementer    |
| 5    | Items 3, 8, 9, 11, 12, 13                                                                        | After the above     |

Each step reports resident memory after N runs, report bytes copied per run, and the
whole-suite result.
