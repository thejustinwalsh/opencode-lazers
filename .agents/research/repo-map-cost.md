# Whole-repository map: size and cached-prefix cost

Read-only measurement. Nothing in the repository was changed; scratch files live in
`/private/tmp/claude-501/-Users-tjw-Documents-ChatGPT-opencode-lazers/b47493ed-6bdc-45ea-82fa-61d28bfbfe2d/scratchpad/map-cost/`.
Tokens are `o200k_base` via repomix 1.18.1 `TokenCounter`. Per-file counts are summed.

## Scope

- Corpus: `git ls-files`, 3,352 entries. 183 binary files are excluded. 3 files are dropped by the product's `runSecurityCheck`, as `processor.ts` does: `src/project-key.test.ts`, `vendor/fallow/crates/api/src/mutation/recorded_args/tests.rs`, `vendor/fallow/crates/config/src/config/parsing_tests.rs`. Result: 3,166 text files, 2,138 of them code (`.ts .tsx .js .mjs .rs .py`).
- **Source without tests (SWT)**: text files under `src/`, `scripts/`, `website/`, `crates/`, plus repo-root files, minus `*.test.ts(x)`, `test/`, names containing `fixture`, `.snap`. 541 files. `vendor/`, `design/`, `contributions/`, `.agents/`, `docs/` are excluded as non-worker code.
- Variant 5 (`structure`): `src/context/index.ts` returns empty text for `structure` (line ~732), so it equals variant 1 (paths only). Not measured separately.
- Variant 3 as the processor runs it: `processor.ts` passes every text file to `processFiles` with `compress: true`. Non-code files come back essentially unchanged (1,028 non-code files: 3.98M tokens compressed vs 4.01M full). The `directory-only` level set in `index.ts` is ignored by the processor. Variant 3c fixes this: code compressed, non-code reduced to path only.
- Variant 1 is a path list, not a box-drawn tree. A rendered tree adds indentation tokens.
- Variant 2 uses a regex over top-level `export` statements (TypeScript 7 in `node_modules` has no JS compiler API). Approximate.

## Part A: sizes (o200k_base tokens)

| variant                                     | whole repo |       SWT | src ex tests |
| ------------------------------------------- | ---------: | --------: | -----------: |
| 1 paths                                     |     41,084 |     4,028 |        3,279 |
| 2 paths + exported names                    |     87,312 |    15,435 |       14,067 |
| 3 compress, processor as written (all text) |  8,631,603 |   500,259 |      331,329 |
| 3c compress code, paths for non-code        |  4,672,056 |   347,750 |      314,850 |
| 4 = 3 minus import statements               |  8,525,721 |   460,459 |      295,150 |
| 4c = 3c minus import statements             |  4,566,174 |   307,950 |      278,671 |
| 5 structure                                 |        = 1 |       = 1 |          = 1 |
| 6 full text                                 | 13,160,759 | 1,657,619 |    1,379,371 |

chars/4 runs within about 1-7 percent of the token counts for every variant (for example variant 6 whole: 13,363,884 chars/4 vs 13,160,759 tokens). Full table in `summary.json` in the scratch folder.

Whole repo, by top-level directory, variant 3 (processor as written) vs variant 6:

| dir                                      |     files |  paths (1) | paths+exports (2) |  compress (3) | minus imports (4) |       full (6) |
| ---------------------------------------- | --------: | ---------: | ----------------: | ------------: | ----------------: | -------------: |
| src                                      |       714 |      5,648 |            16,591 |       415,677 |           351,576 |      2,490,153 |
| test                                     |       100 |        993 |             1,405 |        37,465 |            28,352 |        309,356 |
| docs                                     |         6 |         48 |                48 |         8,386 |             8,386 |          8,386 |
| design                                   |       258 |      3,771 |             3,782 |       714,590 |           714,522 |        727,977 |
| website                                  |        78 |        575 |             1,092 |        50,144 |            47,180 |        146,991 |
| scripts                                  |        16 |        122 |               193 |         4,888 |             3,838 |         26,651 |
| .agents                                  |       424 |      6,976 |             6,978 |     1,330,882 |         1,330,636 |      1,334,617 |
| contributions                            |       232 |      4,155 |             4,166 |     1,634,103 |         1,634,103 |      1,635,384 |
| other (vendor/fallow Rust, crates, root) |     1,338 |     18,796 |            53,057 |     4,435,468 |         4,407,128 |      6,481,244 |
| **total**                                | **3,166** | **41,084** |        **87,312** | **8,631,603** |     **8,525,721** | **13,160,759** |

Largest contributors, variant 3 (processor as written), whole repo. Non-code dominates:

| tokens (3) |    full | path                                                                              |
| ---------: | ------: | --------------------------------------------------------------------------------- |
|    293,099 | 293,100 | contributions/runntime/omni-published-chat/patches/0001-omni-published-chat.patch |
|    245,258 | 245,259 | contributions/runntime/omni-published-chat/evidence/full-gpu.log                  |
|    218,923 | 218,923 | contributions/runntime/upstream-composition/d1-on-upstream.patch                  |
|    135,787 | 135,788 | .agents/docs/evidence/034-renderer-trace/renderer.sample.txt                      |
|    134,005 | 134,006 | .agents/docs/evidence/renderer-freeze-20261101T1540/renderer.sample.txt           |
|    126,904 | 126,904 | contributions/runntime/upstream-composition/focused-gpu.log                       |
|    126,818 | 126,819 | contributions/runntime/d1-q8/evidence/operator-gpu.log                            |
|    124,532 | 124,533 | contributions/runntime/omni-published-chat/evidence/quant-kernels-gpu.log         |
|     95,703 |  95,703 | design/models-panel/benchmark-sources-read-20261102.json                          |
|     67,201 |  67,201 | bun.lock                                                                          |
|     54,683 |  54,683 | design/reviews/worktree-lifecycle-inventory-20261109.json                         |
|     51,942 |  45,674 | vendor/fallow/crates/types/src/results.rs                                         |
|     49,550 |  49,550 | vendor/fallow/Cargo.lock                                                          |
|     47,885 |  38,407 | vendor/fallow/crates/types/src/extract.rs                                         |
|     47,470 |  47,470 | .agents/docs/evidence/maintenance-preflight/lz72-20261103/inspection.json         |

Largest contributors, variant 3, SWT:

| tokens (3) |    full | path                                      |
| ---------: | ------: | ----------------------------------------- |
|     67,201 |  67,201 | bun.lock                                  |
|     30,905 |  30,905 | crates/fallow-wasm/Cargo.lock             |
|     19,860 |  19,860 | website/bun.lock                          |
|     18,233 | 108,370 | src/runner/runtime.ts                     |
|      7,896 |   7,896 | DESIGN.md                                 |
|      6,213 |  40,713 | src/runner/store.ts                       |
|      5,094 |  22,219 | src/observability/read.ts                 |
|      4,863 |  27,651 | src/progress/recorder.ts                  |
|      4,189 |  20,166 | src/verification/opencode/owned-launch.ts |
|      3,648 |  21,527 | src/trajectory-panel/panel.tsx            |
|      3,529 |  20,339 | src/models/observation-ledger-read.ts     |
|      3,407 |  21,961 | src/recovery/handoff/store.ts             |
|      3,310 |  15,316 | src/observability/live-read.ts            |
|      3,262 |  16,552 | src/models/decision-read.ts               |
|      3,210 |  11,982 | src/storage.ts                            |

`runtime.ts` is 17 percent of its full size after compression (2,226 output lines). It is not the dominant contributor the brief expected: three lock files account for 118k of SWT variant 3. Top 15 for variant 3c (code compressed) whole repo are all `vendor/fallow` Rust files, led by `results.rs` at 51,942.

Findings from the measurement:

1. **The processor's outline is not code-only.** `processor.ts` ignores `level`, so logs, patches, JSON and lock files are sent in full. Whole-repo variant 3 is 8.6M tokens, about 4.0M of which is non-code full text.
2. **The processor's own cap rejects the map.** `processor.ts` throws above 256,000 packed tokens. Variant 3 (8.6M whole, 500k SWT), variant 3c SWT (348k) and variant 4c SWT (308k) all exceed it. Only variants 1 and 2 fit.
3. **Rust compression inflates some files.** 217 of 1,235 `.rs` files compress to more tokens than their full text (compress 4.19M vs full 6.21M overall). Tree-sitter keeps doc comments and emits `⋮----` placeholders. Code in `.ts/.js/.py` compresses to 16 percent of full (466,605 vs 2,947,871).
4. The product's security check drops `src/project-key.test.ts`, a test file, as suspicious. Worth a look.

## Part B: model requests per attempt (live database, read-only)

Source: `runner_progress`, `native_tool_calls`, `runner_attempts` in `~/.local/share/opencode/plugins/lazers/tasks.sqlite` (mode=ro). Each `runner_progress` row with `kind='step'` is one assistant message (32,204 rows, 32,204 distinct messages), so one step is one model request. Usage is on the step payload (`usage.input`, `cacheRead`, `cacheWrite`, `output`) with `measurementBasis: additive-step-measurement`.

Worker attempts (the 238 attempts with recorded steps: 174 accepted, 41 failed, 22 cancelled, 1 running):

| metric                                         |    median |        p75 |        p90 |
| ---------------------------------------------- | --------: | ---------: | ---------: |
| model requests (steps) per attempt             |        73 |        159 |        348 |
| model requests, accepted attempts only (n=174) |        65 |        120 |        254 |
| native tool calls per attempt                  |        70 |        106 |        160 |
| read/grep/glob calls per attempt               |        28 |         49 |         89 |
| non-cached input tokens per attempt            |   232,502 |    584,830 |  1,230,815 |
| cache-read tokens per attempt                  | 9,526,016 | 23,793,696 | 51,371,891 |
| cache-write tokens per attempt (recorded)      |         0 |          0 |          0 |
| output tokens per attempt                      |    18,388 |     36,560 |     70,368 |
| cache-read share of input, per attempt         |       97% |        98% |        98% |

Pooled cache-read share is 97.6 percent. Cache-write is recorded as 0 in virtually every step (471,361 tokens across all attempts), so the history does not measure cache writes. The cost model below uses catalogue cache-write prices.

Architect sessions: 390 sessions in `native_tool_calls` (`agent='architect'`, `identity_kind='native-call'`). No `runner_progress` steps or usage exist for them, so requests are not measured directly.

| metric                                                    | median | p75 | p90 |
| --------------------------------------------------------- | -----: | --: | --: |
| tool calls per architect session (upper proxy)            |     15 |  28 |  57 |
| distinct assistant messages with tool calls (lower bound) |     15 |  27 |  54 |

Per-step averages (worker attempts): non-cached input 3,486 tokens, cache-read 139,748 tokens.

## Part C: cost of a cached map prefix

Prices, USD per million tokens, from the `openrouter-models` snapshot (generation 338, `model_evidence_snapshots`). The `native-catalog` snapshot agrees for these models.

| model                     | input | cache-read | cache-write | source notes                                                                        |
| ------------------------- | ----: | ---------: | ----------: | ----------------------------------------------------------------------------------- |
| openai/gpt-6.2-sol        |  2.00 |       0.10 |        2.50 | gpt-6.1-sol identical. Prompts above 272k tokens use the tier at 4.00 / 0.20 / 5.00 |
| anthropic/claude-opus-5.5 |  4.00 |       0.20 |        5.00 |                                                                                     |
| meta/muse-spark-1.3       |  1.25 |       0.15 |           0 | cache-write not listed; treated as 0                                                |
| deepseek/deepseek-v4-pro  |  0.90 |       0.25 |           0 | cache-write not listed; treated as 0                                                |

Formulas, with N the map tokens, R requests per attempt, F fresh exploration tokens:

```
carry cost per attempt  C(N) = N * (cacheWrite + R * cacheRead) / 1e6
fresh exploration cost  E    = F * input / 1e6
break-even              N*   = F * input / (cacheWrite + R * cacheRead)
```

Inputs: F = 407,000 (scout's median fresh tokens before first edit). R = 73 (median) and 348 (p90). Sensitivity with F = 232,502 (this measurement's median whole-attempt non-cached input) is in the break-even table.

Break-even, map size at which carry cost equals fresh-exploration cost (both at F = 407k):

| model           | E (fresh exploration) | N* at R=73 | N* at R=348 | N* at R=73 if F=232.5k |
| --------------- | --------------------: | ---------: | ----------: | ---------------------: |
| gpt-6.2-sol     |                $0.814 |     83,061 |      21,823 |                 47,449 |
| claude-opus-5.5 |                $1.628 |     83,061 |      21,823 |                 47,449 |
| muse-spark-1.3  |                $0.509 |     46,461 |       9,746 |                 26,541 |
| deepseek-v4-pro |                $0.366 |     20,071 |       4,210 |                 11,466 |

Worked example, gpt-6.2-sol, SWT variant 3c, R=73:
`347,750 * (2.50 + 73 * 0.10) / 1e6 = 347,750 * 9.80 / 1e6 = $3.41`.
Break-even: `407,000 * 2.00 / (2.50 + 73 * 0.10) = 814,000 / 9.80 = 83,061`.

Added cost per attempt at R=73 (p90 R=348 in parentheses). Verdict is against each model's break-even at R=73:

| variant                   | tokens whole / SWT     | gpt-6.2-sol     | claude-opus-5.5  | muse-spark-1.3  | deepseek-v4-pro  | vs break-even                                     |
| ------------------------- | ---------------------- | --------------- | ---------------- | --------------- | ---------------- | ------------------------------------------------- |
| 1 paths                   | 41,084 / 4,028         | $0.04 ($0.15)   | $0.08 ($0.30)    | $0.04 ($0.21)   | $0.07 ($0.35)    | below all four                                    |
| 2 paths+exports           | 87,312 / 15,435        | $0.15 ($0.58)   | $0.30 ($1.15)    | $0.17 ($0.81)   | $0.28 ($1.34)    | SWT below all four at R=73; above deepseek at p90 |
| 3c code compress          | 4,672,056 / 347,750    | $3.41 ($12.97)  | $6.82 ($25.94)   | $3.81 ($18.15)  | $6.35 ($30.25)   | above all four                                    |
| 4c code, no imports       | 4,566,174 / 307,950    | $3.02 ($11.49)  | $6.04 ($22.97)   | $3.37 ($16.08)  | $5.62 ($26.79)   | above all four                                    |
| 3 compress as processor   | 8,631,603 / 500,259    | $4.90 ($18.66)  | $9.81 ($37.32)   | $5.48 ($26.11)  | $9.13 ($43.52)   | above all four                                    |
| 4 no imports as processor | 8,525,721 / 460,459    | $4.51 ($17.17)  | $9.02 ($34.35)   | $5.04 ($24.03)  | $8.40 ($40.06)   | above all four                                    |
| 6 full                    | 13,160,759 / 1,657,619 | $16.25 ($61.83) | $32.49 ($123.66) | $18.15 ($86.53) | $30.25 ($144.21) | above all four                                    |

The 4-row values at p90 are computed with the same formula. Whole-repo variant 3c costs $45.79 (gpt) to $91.57 (opus) per attempt at median R.

Fresh exploration displaced, for comparison: $0.37 (deepseek) to $1.63 (opus) per attempt.

Sensitivities, not in the required table:

- **Displaced tokens persist in context.** If the exploration tokens a map would replace also stay in context and are cache-written and re-read, the displaced cost is `F * (input + cacheWrite + R * cacheRead)`. Break-even then rises to `F * (input + cacheWrite + R*cacheRead) / (cacheWrite + R*cacheRead)`: gpt 490k, opus 490k, muse 453k, deepseek 427k at R=73. Under this, SWT variant 3c (348k) falls below break-even for all four models. SWT variant 3 (500k) is just above.
- **gpt-6.2-sol above 272k.** If the higher tier applies to the whole prompt, SWT variant 3c costs about $6.82 (not $3.41) on gpt.
- **Context fit.** Whole-repo variant 3 (8.6M) exceeds every context window in the product's pricing sets. Variant 6 SWT (1.66M) is also too large.

Reading: the cached carry cost scales with R, and median R is 73. Only small maps pay for themselves: SWT paths-with-exports (15k tokens) costs $0.15 per attempt on gpt-6.2-sol. Compressed SWT source costs about 4x (opus, gpt) to 17x (deepseek) the fresh exploration it could displace at median R, before the persistence sensitivity below.

## Could not measure

- **Requests for architect sessions.** No steps or usage are recorded. Tool calls and distinct messages with calls are the only proxies.
- **Cache-write tokens.** Recorded as 0 in practice. Cost uses catalogue prices, not measured writes.
- **The 407k exploration baseline.** Taken from the scout and not re-measured. It does not match this measurement's median whole-attempt non-cached input (232,502). Both break-even sets are given.
- **Exploration before first edit.** Not re-measured. The 28 read/grep/glob median is the whole attempt's count.
- **Variant 5 separately.** It emits empty text by design, so it equals variant 1.
- **Exported names.** Regex-based, approximate for TypeScript.

## Scripts and queries

Scratch folder: `/private/tmp/claude-501/-Users-tjw-Documents-ChatGPT-opencode-lazers/b47493ed-6bdc-45ea-82fa-61d28bfbfe2d/scratchpad/map-cost/`

- `measure.ts`: enumerates `git ls-files -z`, runs `runSecurityCheck` and `processFiles` (config mirrors `src/context/processor.ts`) in batches of 150, counts tokens per file. Writes `analysis.json`. Run with `bun run measure.ts analysis.json`.
- `aggregate.py`: per-group and per-category sums, top-15 lists. Writes `summary.json`.
- `cost.py`: variants 3c and 4c, group totals. Writes `variants.json`.
- `breakeven.py`: break-even N* and carry cost per model.
- `sample.ts`: compressed output for `results.rs` and `runtime.ts`.
- `partb.py`: first attempt at Part B. Its correlated-subquery form timed out on this 2.6 GB database and was stopped. Superseded by the grouped queries below.
- `partb_agg.py`: percentiles over `steps_by_attempt.psv`, `tools_by_attempt.psv`, `attempts.psv`, `architect.psv`.

Queries (all against `file:$HOME/.local/share/opencode/plugins/lazers/tasks.sqlite?mode=ro`):

```sql
SELECT attempt_id, count(*), sum(payload LIKE '%"usage"%'),
       sum(json_extract(payload,'$.usage.input')),
       sum(json_extract(payload,'$.usage.cacheRead')),
       sum(json_extract(payload,'$.usage.cacheWrite')),
       sum(json_extract(payload,'$.usage.output'))
FROM runner_progress WHERE kind='step' GROUP BY attempt_id;

SELECT attempt_id, count(*), sum(identity_kind='native-call'),
       sum(identity_kind='native-call' AND tool IN ('read','grep','glob'))
FROM native_tool_calls WHERE attempt_id IS NOT NULL GROUP BY attempt_id;

SELECT id, state, task_id, number, token_count, tool_count FROM runner_attempts;

SELECT session_id, count(*), count(DISTINCT message_id)
FROM native_tool_calls WHERE agent='architect' AND identity_kind='native-call'
GROUP BY session_id;
```

Prices: `model_evidence_snapshots` where `source='openrouter-models' AND generation=338`, the `prices.tiers[0]` block of each model record (per token, multiplied by 1e6). Cross-checked against `source='native-catalog'`.
