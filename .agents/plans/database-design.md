# Database design: normalize, index, compact

Follows [data handling](../../design/data-handling.md). Measured on the live
`~/.local/share/opencode/plugins/lazers/tasks.sqlite` on 2026-11-20: 2.58 GB, of which
2.13 GB is tables and 454 MB indexes, 4 KiB pages, no free pages, `auto_vacuum` off.
SQLite in the host runtime is 3.54.0 with JSON, JSONB, generated columns, expression
indexes, triggers and FTS5.

Who writes and reads each table is summarized under "Traced facts" below. Every
compaction keeps feature
parity; items marked **verify** depend on that.

## Measurements

| Table                      | Rows   | Size                         | Where the bytes are                                      |
| -------------------------- | ------ | ---------------------------- | -------------------------------------------------------- |
| `runner_progress`          | 117 k  | 353 MB + 43 MB indexes       | `payload` avg 2.0 KB (226 MB); repeated text ids         |
| `runner_conflict_scans`    | 695    | 341 MB                       | `body` avg 514 KB, max 1.7 MB                            |
| `runner_transitions`       | 440 k  | 252 MB + 116 MB in 4 indexes | `payload` avg 465 B (195 MB); `event` text, 156 distinct |
| `native_tool_calls`        | 83 k   | 241 MB + 43 MB indexes       | `payload` avg 1.8 KB (146 MB)                            |
| `model_evidence_snapshots` | 944    | 178 MB                       | `body` avg 197 KB; never pruned                          |
| `task_changes`             | 2.48 M | 150 MB + 154 MB index        | `project_directory` text (3 distinct) is 104 MB          |
| `runner_commands`          | 2.2 k  | 146 MB                       | `receipt` avg 69 KB, max 2.6 MB                          |
| `recovery_progress_facts`  | 469 k  | 143 MB + 61 MB indexes       | ~100 MB of repeated uuid text ids                        |
| `runner_outbox`            | 19.7 k | 104 MB                       | `receipt` 60 MB, `payload` 19 MB, `metadata` 9 MB        |
| `runner_effects`           | 2.6 k  | 38 MB                        | `receipt` avg 14 KB                                      |
| `audit_sections`           | 70     | 31 MB                        | whole Fallow reports, avg 468 KB                         |
| `runner_evidence`          | 756    | 11 MB                        | `body` avg 14 KB                                         |

## Rules

1. **Identity is an integer.** Projects, sessions, plans, tasks and attempts get integer
   keys in small dimension tables (`projects(id, directory, project_id)`, and so on).
   Large tables reference them by integer, not by repeated 36–44 byte text. Event names
   and kinds become small integer enums with a lookup table.
2. **Hot fields are columns; documents are cold.** Fields a reader filters, sorts or
   shows in lists are columns (or `VIRTUAL` generated columns over JSON) with indexes.
   Documents keep only detail that is read by id.
3. **Store once.** The same receipt, payload or report is stored in one place and
   referenced by id from the others.
4. **Store a delta or the latest, not every full copy,** when only the latest or the
   change is read.
5. **Every growing table has a lifecycle:** what reads it, when a row is dead, and the
   retention rule that removes or folds it.
6. **Indexes serve real queries.** Each index names the query it serves; unused or
   redundant indexes go.
7. **Reclaim space.** After compaction, `auto_vacuum = INCREMENTAL` with a scheduled
   `incremental_vacuum`, so freed pages return to the filesystem.

## Changes by table

| Table                                                         | Change                                                                                                                                 | Expected saving   | Verify                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------- |
| `task_changes`                                                | Integer project key; fold consumed changes (change feed only needs rows past every reader's cursor)                                    | ~250 MB of 304 MB | Readers' cursors                       |
| `runner_conflict_scans`                                       | Keep the latest scan per project, or store per-scan deltas                                                                             | ~330 MB           | Whether old scans are read             |
| `runner_transitions`                                          | Integer plan/task keys and event enum; review the 4 indexes (116 MB); fold old transitions of integrated plans into a per-plan summary | 150–250 MB        | Recovery, trajectory and audit readers |
| `runner_progress`                                             | Integer keys; promote the payload fields readers use to columns; drop duplicated content that `native_tool_calls` already holds        | 150+ MB           | Progress and Models ledger readers     |
| `native_tool_calls`                                           | Keep tool call identity and summary columns; store large inputs/outputs once (content-addressed) or truncate to what panels show       | ~100 MB           | Panels' detail views                   |
| `recovery_progress_facts`                                     | Integer keys; fold facts of settled attempts                                                                                           | ~150 MB of 204 MB | Recovery detector                      |
| `model_evidence_snapshots`                                    | Keep the last two generations per source (lane D in progress)                                                                          | ~170 MB           | Models price history                   |
| `runner_commands`, `runner_effects`, `runner_outbox` receipts | Receipt histories as child rows plus summary columns (lane B in progress); one copy of check output referenced by the others           | 150–200 MB        | Delivery and inspection readers        |
| `audit_sections`                                              | Findings as rows; raw report as one compressed export file (Fallow plan item 5)                                                        | ~30 MB            | Audit tools                            |

Expected result: well under half the current 2.58 GB, with smaller indexes, before
retention of settled history.

## Order

1. Trace readers and writers for every table above (finish the interrupted search).
2. Dimension tables and integer keys, with migrations that keep old rows readable.
3. Per-table compaction in the order of the table, each as its own change with
   before and after sizes.
4. Retention rules in `src/retention`, then incremental vacuum.

## Traced facts (read-only search, HEAD d1cb7900)

These settle the **verify** column above; file and line references are in the search
report summarized here.

| Table                                    | Readers and lifecycle                                                                                                                                                                | Decision                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `runner_conflict_scans`                  | No writer since commit `77df0c3c`; no reader; retention kind `scan-history` already deletes by age                                                                                   | Delete all rows now; drop the table in a later migration (~341 MB)                        |
| `task_changes`                           | Every reader takes only `MAX(id)`; retention prunes `mutation` rows but never `insert` rows from the `tasks_changed` trigger                                                         | One counter row per project (or prune `insert` rows too); drop the 154 MB index (~300 MB) |
| `recovery_progress_facts`                | Written by triggers on every `runner_progress` insert and update; the only reader is a live diagnostic (limit 257); the consumer API (`pageIn`/`advanceIn`) has no production caller | Stop the triggers or keep only a bounded recent window for the diagnostic (~200 MB)       |
| `native_tool_calls` vs `runner_progress` | Every tool fact is written to both with the same payload; `toolCalls()` has no caller; `native_tool_calls_session` index serves only it                                              | Store the tool payload once and reference it; drop the unused index                       |
| Check receipts                           | Same receipt stored in `runner_effects.receipt`, `runner_evidence.body` and a progress verification row                                                                              | Store once (effects), reference by id from evidence and progress                          |
| `model_evidence_snapshots`               | Each price refresh merges the previous snapshot's records into the new body; retention keeps the latest per source                                                                   | Store per-record changes or keep two generations (lane D)                                 |
| `runner_commands`                        | Read only for idempotent replay (whole receipt parsed) and audit receipts                                                                                                            | Store a receipt hash and outcome for replay; audit findings move to the findings table    |
| No retention at all                      | `runner_effects`, `runner_evidence`, `audit_sections`, `audit_runs`                                                                                                                  | Add retention kinds tied to plan retirement                                               |
| Retention only when configured           | Automatic retention runs only when `retention_settings.auto_days` is set                                                                                                             | Default a retention period so growth is bounded out of the box                            |

Likely unused or redundant indexes: `native_tool_calls_session`,
`recovery_progress_facts_project_source`, `runner_progress_plan_seq` (plan reads use
`runner_progress_plan_recency`), `model_evidence_snapshots_project_source` (duplicates
the unique index), and one of `runner_transitions_lookup` / `runner_transitions_task_latest`.

Unbounded readers to page or aggregate in SQL: `recovery/trajectory-facts.ts` usage sums
over a whole attempt, `models/observation-ledger-read.ts` full reads of
`runner_progress` and `runner_transitions`, `store.effects(planID)`, `audit/history.ts`
`sections()`.

Fastest safe wins, in order: delete `runner_conflict_scans` rows; collapse
`task_changes`; stop or window `recovery_progress_facts`; drop unused indexes. Together
about 1 GB of the 2.58 GB, with no reader affected.
