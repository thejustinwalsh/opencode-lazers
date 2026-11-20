# Rediscovery measurements from recorded LAZERS tool calls

Read-only analysis of `~/.local/share/opencode/plugins/lazers/tasks.sqlite` (opened `mode=ro`). Nothing in the repository or database was changed. Date of data: 2026-11-20 snapshot.

Sample: 244 worker attempts with progress records (238 with tool calls, 222 with a succeeded edit); 390 Architect sessions (27 with a submitted task); 14,588 worker file reads with a recorded path.

## Recording coverage (what the data can and cannot answer)

| Signal                                        | Recorded                                                               | Coverage                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Worker tool calls (name, status, order, time) | `runner_progress` kind `tool`                                          | 40,902 rows, all keyed by `call_id`                                                               |
| Worker read path and line range               | `content` header `Read file <path>, lines a-b`, or `fileTargets.paths` | 9,888 reads have content; 4,895 have `fileTargets`; 371 reads have no path                        |
| Worker read content size                      | `content` length                                                       | 9,888 of 15,024 read rows                                                                         |
| Worker shell command text                     | `detail`                                                               | 627 of 9,247 shell rows (7%): not recorded for the rest                                           |
| Worker grep pattern                           | `detail`                                                               | ~339 of ~6,058 grep rows (6%)                                                                     |
| Worker glob pattern                           | `detail`                                                               | 108 of 747 glob rows                                                                              |
| Architect read path                           | `native_tool_calls.payload.detail`                                     | 193 of 1,684 Architect reads (11%)                                                                |
| Architect submission                          | `lz-submit-*` tool rows                                                | Only 18 sessions; submissions also run inside Code Mode `execute` (10,628 calls, content omitted) |
| Source context injected into a task           | none                                                                   | Not recorded. `context_receipts` has 19 rows in 1 session.                                        |
| Token usage                                   | `runner_progress` kind `usage-snapshot`                                | Cumulative per session; 239 attempts                                                              |
| `lz-get-task` in worker attempts              | `native_tool_calls` (attempt_id link)                                  | 129 native calls; no content recorded                                                             |

Repository path normalization: absolute paths under the repo root become repo-relative; paths under `runner/worktrees/<uuid>/` strip the worktree prefix. Tool-output spill paths (53 reads) are excluded from path analyses.

Exploration is defined as host `read` (file reads only, not directory or image reads), `grep` and `glob`. Edit is `patch`, `edit` or `write` with status `succeeded`. Shell is reported separately because its command text is almost never recorded. Code Mode `execute` is opaque; its counts are reported as a sensitivity check.

## Q1. Exploration share before the first edit

Workers (n = 222 attempts with a succeeded edit; 16 attempts never edited):

| Measure                                                      | n   | median | p75  | p90  |
| ------------------------------------------------------------ | --- | ------ | ---- | ---- |
| Read+grep+glob calls before first edit                       | 222 | 29     | 42   | 63   |
| Share of all attempt calls that are read+grep+glob           | 222 | 0.24   | 0.35 | 0.45 |
| Share of pre-edit calls that are read+grep+glob              | 222 | 0.82   | 0.89 | 0.92 |
| Code Mode `execute` calls before first edit (not classified) | 222 | 3      | 4    | 5    |

Adding recorded shell exploration changes no value; the recorded shell commands are mostly verification and git status.

Architect sessions (n = 18 sessions with a task submission and native rows before it):

| Measure | n | median | p75 | p90 |
| --- | --- | --- | --- |
| read+grep+glob before first task submission | 18 | 11 | 21 | 30 |
| Share of pre-submission recorded calls that are read+grep+glob | 18 | 0.13 | 0.19 | 0.22 |
| Code Mode `execute` before first submission (opaque) | 18 | 25.5 | 36 | 63 |

Architect "first submission" is defined from `tasks.body.provenance.sessionID` and `createdAt`. The 9 of 27 submitting sessions without native rows are excluded. Most Architect calls are `lz-inspect-plan` (33,207 calls), which is LAZERS context, not repository exploration.

## Q2. Repeats within one attempt

| Measure                                                            | n      | result                                                               |
| ------------------------------------------------------------------ | ------ | -------------------------------------------------------------------- |
| Path-known worker reads                                            | 14,588 | 10,128 (69%) are re-reads of a file already read in the same attempt |
| Distinct files re-read per attempt                                 | 238    | median 5, p75 11, p90 20                                             |
| Repeated reads per attempt                                         | 238    | median 13, p75 43, p90 122                                           |
| Range-recorded reads overlapping an earlier range of the same file | 9,809  | 5,122 (35%); per attempt median 3.5, p75 17, p90 61                  |
| Repeated grep patterns per attempt                                 | 238    | median 0 (only ~339 grep details recorded; too sparse to conclude)   |

Overlap is the stricter measure: a re-read of a different range of the same file is not necessarily redundant.

## Q3. Repeats across attempts and sessions

Each worker session holds exactly one attempt, so attempt and session counts are identical.

- Distinct repository files read: 1,017.
- Files read by at least 2 attempts: 541. At least 5: 228. At least 10: 99. At least 25: 21. At least 50: 9.
- Top 20 files: 43.1% of path-known reads (6,283 of 14,588). Top 50: 58.0% (8,468).
- Same-task reuse: 1,189 of 14,588 reads (8.2%) hit a file an earlier attempt of the same task had already read (32 of 209 tasks had more than one attempt).
- Plan-level Architect reuse: not measurable. Architect read paths are recorded for only 14 plans. Within those, 216 of 14,588 worker reads (1.5%) hit an Architect-read file. This is a lower bound.

Top 30 files (repo-relative | attempts | sessions | read calls):

| File                                      | Attempts | Sessions | Reads |
| ----------------------------------------- | -------- | -------- | ----- |
| src/runner/runtime.ts                     | 73       | 73       | 2,102 |
| src/runner/runtime.test.ts                | 58       | 58       | 643   |
| src/runner/store.ts                       | 85       | 85       | 527   |
| test/observation-panels/root.test.ts      | 26       | 26       | 385   |
| src/runner/retained-reverify.test.ts      | 14       | 14       | 343   |
| README.md                                 | 193      | 193      | 288   |
| src/runner/native.ts                      | 39       | 39       | 235   |
| src/models/comparison-panel.tsx           | 19       | 19       | 228   |
| src/progress/recorder.ts                  | 45       | 45       | 184   |
| src/storage.ts                            | 65       | 65       | 145   |
| src/tasks/panel.tsx                       | 24       | 24       | 135   |
| .agents/docs/opencode-api.md              | 85       | 85       | 130   |
| src/runner/artifacts.ts                   | 30       | 30       | 127   |
| src/models/server.test.ts                 | 20       | 20       | 124   |
| package.json                              | 100      | 100      | 123   |
| src/runner/retained-verification/store.ts | 15       | 15       | 121   |
| src/progress/native.test.ts               | 14       | 14       | 117   |
| src/runner/schema.ts                      | 57       | 57       | 117   |
| src/runner/adopted-descendant.test.ts     | 8        | 8        | 111   |
| src/progress/native.ts                    | 26       | 26       | 98    |
| src/models/decision-read.ts               | 9        | 9        | 97    |
| src/observability/read.ts                 | 21       | 21       | 93    |
| src/runner/native.test.ts                 | 23       | 23       | 91    |
| test/trajectory/fixture.ts                | 39       | 39       | 90    |
| src/verification/opencode/owned-launch.ts | 4        | 4        | 89    |
| src/trajectory/read.ts                    | 25       | 25       | 85    |
| src/runner/host.ts                        | 38       | 38       | 82    |
| AGENTS.md                                 | 53       | 53       | 81    |
| src/models/observation-ledger-read.ts     | 4        | 4        | 80    |
| src/models/comparison-state.ts            | 17       | 17       | 76    |

## Q4. Cost proxy

Recorded read content (all path-known and unknown reads with content): 33.06 M characters, about 8.26 M tokens (chars/4). The top-50 files account for 19.38 M characters, about 4.85 M tokens (58%). Characters include the `N:` line-number prefixes. Reads without recorded content (5,136 rows) are not sized, so these are lower bounds.

## Q5. Does the injected source context reduce exploration?

- Every task's `proposal.writeScope` is non-empty (258 of 258). Literal file paths are present in 214 of the 222 attempts with an edit. The "named" versus "not named" comparison is therefore degenerate. The glob-only group has 8 attempts: median 25 pre-edit exploration calls, too small to compare.
- Injected source entries are not recorded. The "Source context" block is built in `src/tools.ts` (around line 414) from a Repomix snapshot, and nothing persists its file list. Re-reads of injected files cannot be measured.
- Proxy: 6,718 of 14,588 path-known reads (46%) hit a literal writeScope file.
- Attempts with a native `lz-get-task` call (n = 50): median 43 pre-edit exploration calls. Without one (n = 172): median 27. This is confounded (retries and takeovers likely call it more), so it does not show injection increases exploration.

## Q6. Time and tokens to first edit

| Measure                                                                           | n   | median  | p75     | p90       |
| --------------------------------------------------------------------------------- | --- | ------- | ------- | --------- |
| Seconds from attempt `started_at` to first succeeded edit                         | 222 | 519     | 863     | 1,873     |
| Cumulative input+output+reasoning tokens at last usage snapshot before first edit | 222 | 406,754 | 794,052 | 1,564,210 |

Cached-read tokens are excluded. Snapshots are cumulative per session, so the figure is the session total at that point.

## Q7. What agents look for first

- First three recorded calls, most common (of 238 attempts): `execute, shell, read` (38); `execute, execute, read` (35); `execute, execute, shell` (32); `execute, execute, execute` (26); `execute, read, read` (25). Code Mode `execute` dominates the start of attempts, so most first lookups are hidden.
- Architect first three calls: `execute, execute, lz-inspect-plan` in 11 of 390 sessions. The rest are scattered.
- Grep patterns (recorded only, ~339): about three-quarters are multi-term regex. Symbol-only alternations (identifiers joined by `|`) and config or package lookups are a minority (60 and 24 in a heuristic classifier). This split is approximate.

## Not recorded (cannot be answered from this data)

- Shell exploration (commands recorded for 7% of shell rows).
- Content and inputs of Code Mode `execute` calls; these hide reads, greps and submissions.
- Which files the source-context injection contained, and therefore whether workers re-read injected files.
- Architect repository reads by path (11% recorded), so plan-level Architect-to-worker reuse is a lower bound.
- Grep and glob patterns for most calls.

## Appendix: queries and rules

Counts (run with `sqlite3 "file:$HOME/.local/share/opencode/plugins/lazers/tasks.sqlite?mode=ro"`):

```sql
-- Q1/Q2/Q3/Q4/Q6 source rows
SELECT p.attempt_id, p.seq, p.at, p.call_id,
  json_extract(p.payload,'$.tool')  AS tool,
  json_extract(p.payload,'$.status') AS status,
  json_extract(p.payload,'$.detail') AS detail,
  json_extract(p.payload,'$.fileTargets.paths') AS fpaths,
  json_extract(p.payload,'$.content') AS content
FROM runner_progress p WHERE p.kind='tool' ORDER BY p.attempt_id, p.seq;

-- Attempt start for Q6
SELECT id, plan_id, task_id, number, session_id, started_at FROM runner_attempts;

-- Q6 token snapshots
SELECT attempt_id, seq, payload FROM runner_progress WHERE kind='usage-snapshot' ORDER BY attempt_id, seq;

-- Q1 architect rows
SELECT session_id, tool, first_observed_at FROM native_tool_calls
WHERE agent='architect' ORDER BY session_id, first_observed_at, rowid;

-- Q1 architect submission cutoff (provenance inside the task body)
SELECT id, json_extract(body,'$.provenance.sessionID'), json_extract(body,'$.createdAt') FROM tasks;

-- Q5 writeScope and lz-get-task linkage
SELECT id, json_extract(body,'$.proposal.writeScope') FROM tasks;
SELECT attempt_id, COUNT(*) FROM native_tool_calls
WHERE tool='lz-get-task' AND agent='lazers-implementor' AND attempt_id IS NOT NULL GROUP BY attempt_id;

-- Recording coverage checks
SELECT COUNT(*), SUM(json_extract(payload,'$.detail') IS NOT NULL)
FROM runner_progress WHERE kind='tool' AND json_extract(payload,'$.tool')='shell';
SELECT COUNT(*), SUM(json_extract(payload,'$.content') IS NULL)
FROM runner_progress WHERE kind='tool' AND json_extract(payload,'$.tool')='read';
```

Derivation rules (Python, `/private/tmp/claude-501/-Users-tjw-Documents-ChatGPT-opencode-lazers/b47493ed-6bdc-45ea-82fa-61d28bfbfe2d/scratchpad/rediscovery.py`, with `arch.py`, `extra.py`, `agg.py`, `ov.py`):

- Read path: regex `^Read file (.+?), lines (\d+)-(\d+)` on `content`. Fallback: first element of `fileTargets.paths`. `Read directory` and `Image read` are not file reads.
- Worker exploration before edit: index of first row with tool in {patch, edit, write} and status `succeeded`; count rows before it with tool in {read, grep, glob}.
- Repeats: per attempt, `count(path) - 1` over read rows. Overlap: a read whose line range intersects an earlier range of the same path in that attempt.
- Architect submission cutoff: `min(createdAt)` per `provenance.sessionID` from `tasks`; count architect rows with `first_observed_at` before the cutoff.
- Tokens: `input + output + reasoning` from the last usage snapshot whose progress `seq` is below the first-edit row's `seq`. `cacheRead` excluded.
- Time: `(first-edit at - attempt started_at) / 1000` seconds.
- Plan overlap: per `runner_nodes` plan, Architect sessions via task provenance; their `read` details (normalized) intersected with worker reads.
