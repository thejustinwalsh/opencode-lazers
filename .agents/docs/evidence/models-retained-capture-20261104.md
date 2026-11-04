# Actual retained Models capture shape — 2026-11-04

Read-only research for existing LZ122, not an inference benchmark or new execution
gate. No source, native state or database writes, migrations, server actions,
inference, model changes or worker actions were performed. Only aggregate SQL
results entered JavaScript; no prompt, tool-content or reasoning payloads were
reported.

## Source and coherent snapshots

- Main source examined: `0c9be8bcbaef44ea609b67f5d9abfb41db9edb35`.
- Own store: `/Users/tjw/.local/share/opencode/plugins/lazers/tasks.sqlite`.
- Exact project: `/Users/tjw/Documents/ChatGPT/opencode-lazers`.
- Connection: Bun SQLite `{ readonly: true, strict: true }`, deferred read
  transaction per aggregate batch, closed in `finally`; no migrating repository
  constructors and no OpenCode core database access.

At **2026-11-04T16:35:54.144Z**:

| Observation                                                            |                   Actual |
| ---------------------------------------------------------------------- | -----------------------: |
| Tasks / plans / nodes                                                  |          124 / 100 / 118 |
| Attempts / distinct attempt sessions                                   |                122 / 122 |
| Task transitions                                                       |                    2,860 |
| Dispositions / classification annotations / adoptions                  |                9 / 7 / 0 |
| Project progress rows / ledger-joined rows / distinct joined sequences | 29,964 / 29,964 / 29,964 |
| Progress sessions / attempts / tasks                                   |          121 / 121 / 109 |
| Payload UTF-8 bytes                                                    |               58,611,456 |
| Largest payload bytes                                                  |                    7,978 |
| Rows lacking `recorded_at`                                             |                    9,169 |

The overflow is **not join multiplication**: all joined rows matched an owned
attempt's plan/task/session. There were no reused attempt sessions or cross-task
shared sessions in this snapshot; that does not justify removing shared-session
handling. Task bodies, plan bodies, attempt policies and transition payloads added
about 2.6 MB of text; verbose progress dominates.

Principal payload groups:

| Kind/source                     |   Rows | Payload bytes |
| ------------------------------- | -----: | ------------: |
| tool/native-event               | 11,069 |    35,632,627 |
| tool/recovery                   |  2,095 |     6,196,242 |
| step/native-event               |  8,624 |    13,105,093 |
| step/recovery                   |  1,405 |     1,629,595 |
| native-observation/native-event |  4,694 |     1,026,172 |

At a separate coherent read starting **16:36:59.487Z**, live history had 29,975
rows. SQL serialization of the raw progress-row array alone was **85,972,209 bytes
(about 82.0 MiB)**, already above the existing 67,108,864-byte capture limit. This
is a row-envelope proxy, **not measured JavaScript heap allocation or complete
sourceData serialization**. Maximum serialized row: 23,892 bytes; maximum session
history: 1,467 rows / 2,784,752 payload bytes. The earlier project probe's 28,836
rows and these later counts are distinct snapshots, not conflicting results.

## Accounting and completeness risks

- Tool `content` strings alone occupied **20,436,475 bytes**; Models does not expose
  this display content. Loading it through the general trajectory projector is
  avoidable capture work.
- Tool observation arrays occupied **10,790,802 bytes** and step observations
  **7,004,259 bytes**. Do not discard them as though they were display content.
- Observation slots: 40,299 tool, 25,020 step, 1,073 commentary. Step observations
  included 8,960 route objects. Preserve occurrence provenance, not only distinct
  or latest routes.
- Maximum observed arrays were 5 tool / 6 step / 5 commentary; none exceeded 25.
  Historical observations already discarded by the recorder cannot be reconstructed
  or certified complete.
- **25 usage snapshots exceeded 100 event IDs**; maximum **660 IDs / 21,781 bytes**.
  Existing bounded output lineage is a real completeness issue even after capture
  overflow is addressed. Preserve full accounting identities internally or expose
  truthful omissions/uncertainty; do not treat a display prefix as complete input.
- Removing every diagnostic native-observation row would still leave **25,281
  rows**, above 10,000. Diagnostic reduction alone is insufficient.
- Guarded JSON aggregates found no malformed payloads/observation arrays. A later
  aggregate at **16:38:22.836Z** found 120 sessions with cumulative usage, 119 with
  additive steps, no additive-only sessions and two sessions missing retained
  usage. Three additive usage objects lacked all five numeric categories: missing
  must remain missing, never zero.

## Query and capture implications

The exact ledger join was reproduced using `runner_progress`, `runner_plans` and
`tasks`, requiring all three project-directory bindings. Measurements used SQL
`count(DISTINCT seq)`, source/kind grouping and
`length(CAST(payload AS BLOB))`; shape queries guarded JSON with `json_valid`.
Row-envelope sizing used every progress column and retained payload/lineage as
text strings, then summed row byte lengths plus array separators. These are logical
SQL facts, not SQLite-file-hashing evidence.

Individual observed research-query costs were 446.844ms for membership/bytes,
407.250ms for source/kind grouping and 238.542ms for envelope sizing. They are not
ledger timings, inference benchmarks, performance targets or budgets.

For the existing LZ122 scope:

1. Capture once using bounded batches in one SELECT-only transaction, project
   incrementally to accounting inputs, then release the transaction before paging
   immutable captured results. Explicitly dispose capture-owned resources.
2. Bound raw input and retained projection bytes incrementally, not only after
   `.all()` plus serialization. Select limits from actual shapes, not blind cap
   inflation.
3. Preserve all attempts, acceptance/artifact history, classifications/dispositions,
   cross-task session ownership, gaps, source missingness and occurrence identities.
   Choose cumulative snapshots or deduplicated additive subtotals, never sum both.
4. A stable cursor secret alone does not stop the current public `read()` from
   recapturing every page. A sequence cutoff is also insufficient because recorder
   `appendIn` updates existing rows, payloads, lineage and timestamps.
5. Genuine necessary-data/row/byte/output exhaustion remains incomplete/unknown,
   never a complete-looking prefix. Preserve the distinction between raw task
   records and logical outcomes, including the separate LZ119/LZ124 correction
   accounting research in the handoff.

Source boundaries: `src/models/observation-ledger-read.ts:338–583,1937–1980` and
`src/progress/recorder.ts:413–426,960–1000`, as of the examined revision.
