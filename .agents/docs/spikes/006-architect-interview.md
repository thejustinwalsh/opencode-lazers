# 006 — Desktop interview evaluation

Question: Does Architect resolve material ambiguity and produce a scoped, verifiable task from a feature-only request?

Increment: Evaluate and refine the packaged definition through native OpenCode Desktop. Review deterministic schema validation and the public API for an optional local semantic reviewer.

Scope: Agent definition, schema portability repair, focused checks, and evaluation/API documentation. Starting HEAD `b5da4ca` is an empty initial commit; source files remain untracked. Do not implement submission idempotency, workers, dispatch, scheduling, or a local inference service. Concurrent WebGPU work is separate.

Acceptance: Record the exact input, native model/variant selection, questions before submission, persisted task, and verification quality. Structural validation must precede persistence. Separate source/type evidence from inference evidence, and submission from execution.

Execution: One Codex worker; all model prompts and controlled answers entered through Desktop with the ChatGPT subscription. User requested Luna Max, Luna Low, concise evidence-based tuning, then one final Sol High test. No model sessions were driven through CLI/service APIs. A supported background-service maintenance restart was separately authorized by the user.

Budget: $0 paid OpenRouter spend. The original 30-minute/80-call setup allowance was exceeded during authentication/configuration repair and subsequent user-requested comparison trials; do not report it as met. Models have a host limit of 12 steps per input. Proposed execution budgets are task data and are not yet enforced.

Verification: Native Bun formatting/lint/typechecking passed together before the last evidence export. Final lint and typechecking pass; a later full verify is blocked only by formatting in the concurrently edited `src/webgpu/server.ts`, which this evaluation did not alter. Evaluation files pass focused formatting. Full current suite: 29 tests / 154 assertions, including concurrent WebGPU tests; the focused task/Architect slice is 17 tests / 91 assertions. All four retained task envelopes independently parse through `TaskSpecSchema`.

Outcome: Architect investigated the repository, asked material questions before submission, and persisted valid tasks in Desktop on all three scored model settings. Semantic task quality differed. This establishes the current plugin's interviewing/submission slice, not full orchestration or generalization.

| Trial                     | Definition body | Interview                                 | Persisted task                                  | Review                                                                                                                                 |
| ------------------------- | --------------- | ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Initial Sol High baseline | 138 words       | Retry identity                            | [5f5743c3…](../evidence/006-baseline-task.json) | Strong restart/concurrency coverage; different controlled answer from later trials.                                                    |
| Luna Max                  | 164 words       | Retry identity                            | [bb651358…](../evidence/006-luna-max-task.json) | Covers distinct keys, validation, isolation, migration; restart check only reopens SQLite in one process.                              |
| Luna Low                  | 164 words       | Retry identity                            | [30a98786…](../evidence/006-luna-low-task.json) | Covers conflict, isolation, validation; same-process reopen and missing acceptance for distinct keys with identical content.           |
| Final Sol High            | 171 words       | Retry identity and mandatory/optional key | [1b774b28…](../evidence/006-sol-high-task.json) | Explicit fresh-process/lost-receipt check, distinct keys, concurrency, rollback, permissions, isolation, migration, and quality gates. |

Final task ID: `1b774b28-c1a4-4df4-900f-fea015ea84bc`, revision 1, status `submitted`. No implementation or completion is claimed. The task includes bounded write paths, concrete commands, explicit limits, and seven acceptance assertions. Its restart criterion establishes the original ID independently of the dropped receipt and forbids an in-process cache from satisfying the check. Concurrent tests require separate connections/competing subprocesses. Execution of those future checks has not occurred.

After restoring normal plugin configuration, Desktop retrieved original baseline task `5f5743c3-1bd0-4a53-a86b-a347dd961e1a` after the real background-service restart, returning revision 1 and stored status `submitted` without resubmission. The [retrieval trace](../evidence/006-restart-retrieval-trace.json) retains only that later turn, so it does not alter the baseline trial's token totals. This separate check used 37,444 uncached input, 34,688 cached input, 97 visible output, and zero reasoning/cache-write tokens (estimated API equivalent $0.0793268).

The prompt change after Luna adds requirement-to-acceptance mapping and checks that expose plausible incorrect implementations at the claimed boundary. It contains no feature-specific retry/database instructions. Sol's result covers the observed gaps, but changing both model and definition prevents attributing the improvement solely to wording. The [method and limitations](../evidence/006-evaluation-method.md) records exact inputs, hashes, isolation details, exclusions, and pricing assumptions.

Focused native-export traces: [baseline](../evidence/006-baseline-trace.json), [Luna Max](../evidence/006-luna-max-trace.json), [Luna Low](../evidence/006-luna-low-trace.json), [final Sol High](../evidence/006-sol-high-trace.json). Reasoning content and encrypted metadata are omitted. Initial failures, a rejected workflow-choice candidate, and a Luna run that reused an existing task are not scored as fresh interviews.

| Trial             | Uncached input | Cache read | Visible output | Reasoning tokens | Estimated API equivalent |
| ----------------- | -------------: | ---------: | -------------: | ---------------: | -----------------------: |
| Baseline Sol High |         32,243 |    134,400 |          2,951 |              425 |                $0.111686 |
| Luna Max          |         58,191 |    286,592 |          2,479 |           14,974 |              $0.01741152 |
| Luna Low          |         28,676 |     71,040 |          1,300 |                0 |                $0.004228 |
| Final Sol High    |         41,794 |    160,128 |          3,524 |              550 |               $0.1403408 |

Cache writes were zero. Estimates use dated OpenRouter standard rates, including reasoning at output prices; these are not subscription charges. Manual waiting is included in Desktop elapsed times, so elapsed times are not compared.

Setup repairs: OAuth renewal resolved the initial 401. Removing obsolete global `provider.openai.api: "codex"` resolved an invalid URL caused by the pinned V1 migration mapping that field to `settings.baseURL`; a mode-0600 backup was retained. A subsequent provider rejection exposed `\p{Cc}` in exported JSON Schema: JSON Schema cannot carry the required JavaScript Unicode regex flag. Explicit equivalent C0/C1 ranges now preserve control-character rejection and Unicode filenames, with a focused unflagged-schema-pattern test.

Concurrent integration issue: WebGPU code briefly imported `Tool` from an unsupported export. Even after that source was repaired, the background service retained a failed import and ignored new plugin options. Native Desktop Restart restarted only the window. The user-authorized `opencode service restart` cleared the stale cache; logs then confirmed the final isolated database loaded. Temporary evaluation configuration was removed afterward and logs confirmed the normal task database loaded. Normal task rows were not modified by the isolated Luna/final trials.

The user's original task methodology is the governing rule: ask only when the answer changes what must be built. A proposal/persist/implementation-choice interview was our mistaken criterion; that candidate was rejected and stopped. A scheduler-availability preflight was also removed. Neither belongs in the agent or a stopgap product mode.

The [local decision-model recipe](../local-decisions.md) documents typed provider registration and the existing System One decision protocol. Examples typecheck against pinned dependencies. Structural Zod validation stays authoritative; a semantic model would need intent, answers, and code evidence and must remain unresolved on failure. No local model was started by this evaluation.
