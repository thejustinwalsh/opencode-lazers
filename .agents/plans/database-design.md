# Database design: normalize, index, compact

Follows [data handling](../../design/data-handling.md). Measured on the live
`~/.local/share/opencode/plugins/lazers/tasks.sqlite` on 2026-11-20: 2.58 GB, of which
2.13 GB is tables and 454 MB indexes, 4 KiB pages, no free pages, `auto_vacuum` off.
SQLite in the host runtime is 3.54.0 with JSON, JSONB, generated columns, expression
indexes, triggers and FTS5.

Who writes and reads each table is summarized under "Traced facts" below. Every
compaction keeps feature parity; the **verify** column names the readers to keep
working.

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

1. Trace readers and writers for every table above. **Done** (see "Traced facts" and
   "Corrections to the trace").
2. Dimension tables and integer keys, with migrations that keep old rows readable.
   **Done for `runner_transitions` and `runner_progress` (branch `feat/integer-keys`); see
   "Integer identity: landed".**
3. Per-table compaction. **Done:** `task_changes` (counter rows), `recovery_progress_facts`
   (bounded window), `runner_conflict_scans` (dropped), outbox receipts (child rows), the four
   unused indexes. **Left:** `native_tool_calls` / `runner_progress` payloads, check receipts,
   `runner_transitions` payloads (see below).
4. Retention rules in `src/retention`, then incremental vacuum. **Done:** superseded rows are
   purged by default; the retention pass returns free pages in 2000-page steps; the one-time
   `VACUUM` is `scripts/compact-database.ts`.

### Corrections to the trace

| Claim in the trace                                                                            | Found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every tool fact is written to `native_tool_calls` and `runner_progress` with the same payload | The payloads differ. `native_tool_calls.payload` merges every observation of a call (hook before, hook after, native events) and applies `targetOnlyTool` and status provenance; `runner_progress.payload` of kind `tool` is merged separately by `appendIn` and, on a fixture run, lacked the `before` observation. A shared copy would need a semantic delta, and `runner_progress.payload` has 52 statements in 16 files (observability, models, trajectory, recovery, tasks) that read it. Left. |
| Same check receipt in `runner_effects.receipt`, `runner_evidence.body` and a progress row     | The progress verification row (`recorder.ts` `recordVerification`) is a summary (check id, result, exit code, timing), not the receipt. The full receipt is in effects (inside a history entry) and evidence. The duplicated part is bounded by `runner_evidence` (11 MB live); not worth the risk to the readers of `receipt.check`. Left.                                                                                                                                                          |
| `runner_commands` receipts need a hash and outcome for replay                                 | Replay returns the whole receipt (`store.command`, `store.priorCommand`), so the receipt stays. The bytes are audit receipts. On a fixture of 2200 receipts (every eleventh a 690 KB audit receipt, the rest 2 KB; 142 MB), the pass removed 195 rows and 134.6 MB, and the file went from 36122 to 3122 pages. They are superseded by newer audits, which the age-independent kind `audit-receipts` already removes. It now runs by default.                                                        |
| One of `runner_transitions_lookup` / `_task_latest` is redundant                              | All four are used by distinct statements (EXPLAIN QUERY PLAN with and without each).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `task_changes` readers take only `MAX(id)`                                                    | Per project and per `kind`, and `tasks.created_version` takes the id from the insert trigger.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Stop the facts triggers                                                                       | The live radar diagnostic reads the newest 257 facts, so a window of 1024 per project stays.                                                                                                                                                                                                                                                                                                                                                                                                         |

### Lifecycle of each growing table

| Table                                                              | Read by                                       | A row is dead when                                                | Removed by                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `runner_commands` (audit receipts)                                 | idempotent replay of the same request id      | a newer audit receipt exists for the project (newest 5 stay)      | kind `audit-receipts`, **by default** (age-independent)                                   |
| `task_changes`                                                     | `MAX(id)` readers                             | never grows (one row per project and kind)                        | n/a                                                                                       |
| `recovery_progress_facts`                                          | live radar diagnostic (newest 257), consumers | outside the newest 1024 per project and behind every consumer     | trigger prune (64 per write) and kind `recovery-fact-window`, **by default**              |
| `runner_progress`, `native_tool_calls`, `runner_transitions` noise | trajectory, radar, models ledger, recovery    | the plan is finished and untouched for the owner's chosen age     | kinds `progress`, `tool-calls`, `transitions`, only with an age (automatic when set)      |
| `runner_outbox` (+ receipts)                                       | delivery, inspection                          | delivered or superseded for a retired plan                        | kind `notices`, with an age                                                               |
| `runner_effects`, `runner_evidence`, `runner_attempts`             | integration proofs, inspection, takeover      | never: retained by contract (the preview lists them as protected) | none                                                                                      |
| `audit_sections`, `audit_runs`                                     | audit tools                                   | not decided: whole Fallow reports; needs the audit owner          | none yet                                                                                  |
| `model_evidence_snapshots`                                         | Models price history                          | superseded and older than the age                                 | kind `model-snapshots`, with an age; lane D decides whether older generations need an age |

An age is the owner's choice, never a default: it decides how long finished work stays
inspectable. Only rows with a superseding successor are removed without one.

### Integer identity: design

Counts of statements outside tests: `runner_transitions` 70 in 26 files, `runner_progress` 52
in 16 files, `recovery_progress_facts` 10 in 5 files. The last is now bounded to 1024 rows
per project (about 1 MB), so integer keys there save nothing and are dropped from the plan.

For the other two, converting readers together with writers in one branch would touch the
observability, models and trajectory read paths that other work is changing. The exact
sequence that keeps every reader working at each step:

1. Add `lazers_plan_keys(n INTEGER PRIMARY KEY, plan_id TEXT UNIQUE)` (and the same for
   attempts) in the `runner` module. A write path takes the key with
   `INSERT ... ON CONFLICT DO NOTHING RETURNING n`.
2. Add nullable `plan_n` (and `attempt_n`) columns to `runner_transitions` and
   `runner_progress`; new rows fill them. Existing rows are filled in pages of 1000 by an
   idle step in the retention pass (`UPDATE ... WHERE plan_n IS NULL LIMIT`), reporting rows.
3. Add the integer indexes next to the text ones, run EXPLAIN over all 122 statements
   (script kept in the review notes), and move one reader file per commit from
   `plan_id=?` to `plan_n=(SELECT n FROM lazers_plan_keys WHERE plan_id=?)`.
4. When no statement names the text column, drop the text indexes, then the text column with
   `ALTER TABLE DROP COLUMN`, followed by a `VACUUM` window (the table rewrite is the one big
   step, so it belongs to `scripts/compact-database.ts`).

Saving estimate: `plan_id`, `task_id`, `attempt_id` and `session_id` are 36 to 44 bytes
each and repeat on every row (117 k progress rows, 440 k transitions): about 150 bytes a
row, 80 MB for progress and 60 MB for transitions plus their text indexes, before the
retention of old plans.

### Integer identity: built

Fixture of 440 000 transitions and 117 000 progress rows with live-shaped ids and payloads
(`bun scripts/measure-integer-keys.ts`, SQLite 3.54, 4 KiB pages).

| Step                                                      | Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Key tables                                             | `lazers_plan_keys`, `lazers_attempt_keys` (`src/runner/identity-keys.ts`). A trigger on `runner_plans` and `runner_attempts` keys each new row; install keys the existing ones (thousands of rows).                                                                                                                                                                                                                                                                                                               |
| 2. Nullable `plan_n`, `attempt_n`, written and backfilled | Writers (`RunnerStore.record`, the progress recorder) write the keys in their insert. An AFTER INSERT trigger keys any other insert (retire-gates, an older copy still loaded). `ALTER ADD COLUMN` at install is metadata only (10 ms). The retention idle step (`RetentionService.backfillKeys`, called from `autoTick`) fills old rows in pages of 1000 rowids, one transaction each, with a turn of the event loop between pages: one page per tick while attempts run, a whole 800 ms slice at a quiet point. |
| 3. Integer indexes, readers                               | `KEY_INDEXES` (`transition-indexes.ts`) are built after a table's backfill (inline under 20 000 rows, otherwise by the existing worker). Readers moved: see below.                                                                                                                                                                                                                                                                                                                                                |

Fallback rule while the backfill is incomplete: a per-table flag, `lazers_key_backfill.complete`,
set only when the backfill has passed the last row and the integer indexes exist. Until then a
reader runs the statement it always ran; afterwards the same statement with `plan_id=?` swapped
for `plan_n=(SELECT n FROM lazers_plan_keys WHERE plan_id=?)` (`planIs` / `attemptIs` in
`identity-read.ts`), same bound parameters. A flag, not COALESCE: `plan_n=K OR (plan_n IS NULL AND
plan_id=?)` cannot serve the lookup and the ordering from one index and would keep the text indexes
in every plan. Readers cache a true flag per connection; it never returns to 0.

Measured on the fixture:

| Page of 1000 rows    | p50      | p95      | max      | whole table          |
| -------------------- | -------- | -------- | -------- | -------------------- |
| `runner_transitions` | 6.2 ms   | 15-18 ms | 40-50 ms | 440 pages, 3.3-3.8 s |
| `runner_progress`    | 27-31 ms | 30-43 ms | 34-54 ms | 117 pages, 3.2-3.8 s |

| File and index bytes                                        | File     | Transitions table + indexes | Progress table + indexes |
| ----------------------------------------------------------- | -------- | --------------------------- | ------------------------ |
| Before (text only)                                          | 915.4 MB | 258.1 + 141.8 MB            | 480.4 + 33.7 MB          |
| After step 2 (columns, backfilled)                          | 916.0 MB | same (+0.6 MB in rows)      | same                     |
| After step 3 indexes (text and integer)                     | 990.4 MB | 258.1 + 216.2 MB            | 480.4 + 44.3 MB          |
| Step 4 simulated (text indexes and columns dropped, VACUUM) | 826.8 MB | 258.1 + 64.4 MB             | 480.4 + 22.0 MB          |

Index builds after the backfill: 1.1 s for transitions, 0.4 s for progress. Step 4 simulated on a
copy takes 14.8 s, which is why it belongs to `scripts/compact-database.ts`. The saving is
88.7 MB (9.7 %), all of it indexes. **The estimate of about 150 bytes a row is not realised for
the table pages with plan and attempt keys alone:** a transitions row is about 540 bytes, so
dropping 36 bytes leaves 7 rows per 4 KiB page either way, and a progress row (2.4 KB) occupies
one page and its overflow either way. Table bytes shrink only if `task_id`, `session_id`,
`project_directory` and `project_id` also become keys (the payload, 95 % of the bytes, is the
other plan item). Step 4 as scoped is worth doing for the indexes; the table saving needs those
dimensions first.

Readers moved (parity test against the text statement on the same rows while incomplete and after
completion, and `EXPLAIN QUERY PLAN` showing an integer index and no scan; run with
`EXPLAIN_VERBOSE=1` to print the plans): `src/runner/store.ts` plan-scoped reads (`activityEvents`,
`activityCount`, `hasActivity`, `activity`, `recordSourceScanFailure`, `latestTransition`,
`latestTransitionVersion`, `verificationTimeoutAmendments`, `latestRetainedRepair`) and
`src/runner/retained-repair-records.ts`. Each integer plan is a `SEARCH ... USING INDEX
runner_transitions_*_n (plan_n=? ...)` plus one `SEARCH lazers_plan_keys` by its unique index; the
text plans were the same shape on `runner_transitions_lookup`, `_task_latest`, `_plan_id`, `_plan_event`.

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

## Integer identity: landed (2026-11-21)

The owner chose to finish the work above. What changed from the plan:

- **Step 4 is online and drops indexes only.** Each history table moves through the
  `identityKeys` lifecycle (`src/runner/lifecycle-machines.ts`):
  `backfilling -> indexing -> keyed -> text-retired`. The retention idle step
  (`advanceIdentityKeys`, `src/runner/identity-migration.ts`) keys a page of 1,000 rows per
  transaction, builds the integer indexes at a quiet point (a worker on a large table), then drops
  one text-id index per transaction and returns the pages with the existing incremental vacuum.
  The stored state is the resume point. While attempts run it only keys pages.
- **The text columns stay.** Dropping them is a table rewrite (about 15 s, offline) for the row
  bytes alone; the measurement below shows the index drop holds nearly all of the saving. The
  columns keep result columns, joins driven from the history row and the key triggers working.
- **Every predicate moved.** All plan and attempt predicates on the two tables go through
  `planIs`, `planIn`, `planJoin`, `samePlan`, `attemptIs`, `attemptIn`
  (`src/runner/identity-read.ts`): the text form until the table is `keyed`, the integer form after.
  `src/runner/identity-predicates.test.ts` fails on a new text-id predicate.
- **A new database never builds a text-id index:** install settles its empty tables straight to
  `text-retired`, so the test suite runs the integer path.

Measured with `bun scripts/measure-integer-keys.ts --transitions 420000 --progress 80000` (the
live row counts on 2026-11-21 are 418,298 and 78,764), `auto_vacuum=INCREMENTAL`, 4 KiB pages,
while other test runs shared the machine:

| Bytes                        | Before   | Migrated (pages free) | Pages returned | Full `VACUUM` |
| ---------------------------- | -------- | --------------------- | -------------- | ------------- |
| `runner_transitions` rows    | 246.4 MB | 246.4 MB              | 246.4 MB       | 246.4 MB      |
| `runner_transitions` indexes | 119.7 MB | 61.5 MB               | 61.5 MB        | 61.5 MB       |
| `runner_progress` rows       | 328.5 MB | 328.5 MB              | 328.5 MB       | 328.5 MB      |
| `runner_progress` indexes    | 20.3 MB  | 14.8 MB               | 14.8 MB        | 14.8 MB       |
| File                         | 717.9 MB | 780.1 MB              | 654.8 MB       | 654.8 MB      |

The saving is 63.1 MB of the file (8.8 %), all indexes. The file peaks 62 MB larger while both
index sets exist; the incremental vacuum returns the text indexes' pages, and a full `VACUUM`
adds nothing. A page of 1,000 rows commits in 6 ms (p50, transitions) and 35 ms (progress); the
whole migration took 7 slices of 800 ms (6.3 s of work), the integer index builds included.

## Integer identity: measured, not merged (2026-11-20; superseded by "landed" above)

Branch `fix/integer-keys` (not merged) built steps 1 and 2 (key tables for plans and attempts;
nullable integer columns on `runner_transitions` and `runner_progress`, backfilled in pages of
1,000 rows) and moved 2 of about 32 reader files. Measured on a fixture of 440,000 transitions and
117,000 progress rows (915.4 MB):

| Phase                                               | File     |
| --------------------------------------------------- | -------- |
| Before                                              | 915.4 MB |
| Integer columns backfilled                          | 916.0 MB |
| Integer indexes beside the text ones (until step 4) | 990.4 MB |
| Text indexes and columns dropped, then `VACUUM`     | 826.8 MB |

The saving is 88.7 MB (9.7%), all of it in indexes. The table pages do not shrink: a transitions
row is about 540 bytes, so dropping a 36-byte id still leaves 7 rows per 4 KiB page, and a progress
row is one page plus overflow either way. The earlier estimate of about 150 bytes per row was
wrong. Getting there means converting about 30 more reader files, a period in which the file is
74 MB larger, write triggers on both tables, and a 15 s offline `DROP COLUMN` plus `VACUUM`.

What would shrink the tables themselves: the payload columns (`runner_progress.payload` is most of
its 480 MB), not the ids. That is retention and payload shape, covered above.

Recommendation recorded for the owner: do not continue integer identity for these two tables.
