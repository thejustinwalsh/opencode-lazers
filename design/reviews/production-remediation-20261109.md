# Production-readiness remediation

Owner: Codex, under Justin's 2026-11-09 remediation instructions. Execute the
ordered waves from the external review; preserve the existing roadmap and worker
work. The independent review is not copied into this repository. Its location:

`/private/tmp/claude-501/-Users-tjw--claude-spares-spare-K0mQ5r/3d9ed59a-5d6f-4605-9d61-499d6be08b8c/scratchpad/lazers-production-readiness-review-20261109.md`

Read findings by symbol against current source. One finding per code commit;
automatic formatting/lint, typecheck and relevant behavior tests gate each commit.
The eleven reconciliation answers require Justin's recorded decisions before
dependent fixes. No question's default selection establishes an answer.

## Pre-edit baseline

Both full suites ran before repository edits, at clean HEAD
`a20c41ab858b44670c3c031eb40ee4cec08b1a23`. HEAD and working tree were unchanged
through both runs. The native cleanup worker continued in its separate checkout;
Architect confirmed an integration/activation hold.

| Run | Started, Unix ms | Finished, Unix ms | Result                      | Duration |
| --- | ---------------: | ----------------: | --------------------------- | -------: |
| 1   |    1794242015331 |     1794242459006 | 1,733 pass / 4 fail; exit 1 | 443.58 s |
| 2   |    1794242459050 |     1794242872428 | 1,733 pass / 4 fail; exit 1 | 413.30 s |

Each run covered 1,737 tests across 179 files, with 19,316 assertions. Both had
the same four named failures, also matching the review's second-run failure set:

- `src/trajectory/read.test.ts`: trajectory presents commentary separately from
  automatic worker facts without granting authority.
- `test/current-idle-hook/replacement-verification.test.ts`: replacement idle
  callback reaches normal verification only for zero background.
- `test/trajectory-panel/panel-state.test.ts`: live status and progress do not
  cancel page-size-two history or rewrite its event selection.
- `test/trajectory-panel/live-delivery.test.ts`: native status deltas preserve
  mutable tool progress, retry delivery and scoped full recovery.

Complete logs and machine-readable timestamps/source boundaries remain in
`/private/tmp/lazers-remediation-baseline-20261109/run-{1,2}.{log,json}`.
Their raw failure arrays repeat Bun's end-of-run summary; the distinct set is
the four cases above. These are pre-existing failures, not permission to ignore
new failures or to assume later failures are timing noise.

## Existing S15-1 cleanup receipt

Justin supplied the completed native CLI receipt `{"status":"cleaned"}` for
the owned verification root ending `lazers-full-instance-9TcU4T`, with 282 MB
reclaimed. Codex did not rerun the cleanup. Read-only confirmation found no PID
25100, no listener on port 53408, and zero entries in the verification root.
This establishes the manual cleanup, not S15-1 closure: the reaper is still open.
The separate retained-verification workspace cleanup finding remains open too.

## Reconciliation register

All eleven questions were presented through structured question prompts. Justin
answered on 2026-11-09. Record his product intent rather than treating an offered
implementation option as the decision when his answer differs from both options.

| #   | Decision and implementation boundary                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Justin expects shared XState workflows and consistent vocabulary. Explained the concrete divergence: an accepted plan ends normal execution, whereas an accepted task can enter repair. Do not silently equate domain-specific states or introduce a third lifecycle authority; align with #11.            |
| 2   | Always value actual model/effort/tokens at current published market prices; historical billing accuracy is not a product goal. Retain execution identity and measured tokens. Land exact-decimal substitution and three-way equality test before merging pricers.                                          |
| 3   | Accept the assigned input or a durably reconciled review-input alias.                                                                                                                                                                                                                                      |
| 4   | Durable current owner plus exact session/attempt binding establishes authority; native parentage remains launch history.                                                                                                                                                                                   |
| 5   | Separate stored commentary and automatic-tool invocation records, displayed together in one chronological timeline. Justin confirmed Opus's recommended correction; use the existing invocation UUID and preserve both facts.                                                                              |
| 6   | A present task/session must have useful tracked data. An unavailable label is not an adequate product outcome. Before changing inventory semantics, distinguish optional native inventory acquisition from durable managed-session facts; do not fabricate successful reads.                               |
| 7   | Explicit user settings must be predictable and honored, especially agent model bindings. Packaged defaults fill unset settings rather than replacing user choices.                                                                                                                                         |
| 8   | After Architect merges work, terminate the worker and remove its branch; workers must not continue after integration. Preserve unmerged/dirty work and history; use native cleanup and the existing absence proof. Integration ordering and old-session holds must be corrected together.                  |
| 9   | Redact keys at record time, before DB persistence. Shared public panel error formatting may preserve actionable messages without arbitrary object serialization. Existing trajectory privacy protection remains in this increment; this does not establish that all persistence writers have been audited. |
| 10  | Arrow keys move the divider in their direction; Down enlarges the upper pane.                                                                                                                                                                                                                              |
| 11  | XState is the intended authority for every workflow state machine and transition, enabling common inspection/rendering and future decision engines. Do not remove XState under the review's deletion proposal. Bounded correctness fixes remain separate from broader authority alignment.                 |

## Wave 1: S1-1

Re-located `beginSourceGuard()` and reproduced the defect against the real module:
A installed/matching; B begins; B disposes; A remained uninstalled/nonmatching.
`dispose()` now selects the most recent installed surviving registration when
disposing the current one. Pending replacements still fence older scopes; the
last pending survivor can finish installing, and empty registrations are removed.
The real-module probe after the fix returned installed/matching before B,
uninstalled/nonmatching during B, and installed/matching again after B disposed.

Added the exact failed-load sequence and newest-survivor/idempotent-disposal
behavior tests. Re-derived an additional defect assertion not listed in the
review's six-test table: `source-fence-rpc.test.ts` expected both replacement
disposal and full plugin early setup failure to leave the surviving guard
disabled. Those expectations now assert restoration, with S1-1 comments.

Checks: `bun run verify` passed, including automatic formatting/lint and strict
typecheck. `bun test src/runner/source-quarantine.test.ts
src/runner/source-fence-rpc.test.ts`: 8 pass / 0 fail, 51 assertions.
The installed service has not been explicitly reloaded to activate this increment.

## Wave 1: F-S14-1

Before the fix, structured RPC failures reproduced `[object Object]` in all eleven
new regression cases (Tasks, Radar and nine Models fields). The shared
`panelErrorMessage()` now extracts the existing public message/recovery fields,
strips control characters and retains the existing display bound without coercing
unknown objects. Tasks, Radar and Models use it; trajectory's existing privacy
formatter is preserved. This is message formatting, not a replacement for
record-time credential redaction.

Symbol searches also found raw coercion in the graph layout error state and its
native worker adapter. Both now use the same helper. All tested error fields
reject `[object Object]`, including activity, optional topology, monitor reads
and graph layout. A structured layout rejection retains its actionable message.

Checks: final `bun run verify` and `git diff --check` passed;
73 behavior tests / 488 assertions across the shared helper and four panel
controllers passed. Layout behavior tests: 8 pass / 0 fail, 37 assertions.
The full-suite comparison is recorded below.
No installed-service activation or native visual acceptance is claimed.

## Re-derived findings and coordination

- S6-4/F-S4-9's absent handoff-tool premise no longer matches HEAD:
  `registerRecoveryTools()` is called in `src/index.ts`, and
  `src/recovery/tools.ts` registers both handoff tools using `HandoffReviewer`.
  Preserve that implementation. Full native handoff walkthrough remains unproven.
- Desktop coordination request `msg_1c1280bb7001cnwncleorM5hPC`
  (Unix1794241989636) preserved LZ-185's SAME worker while holding source
  integration/activation and overlapping dispatch. Architect confirmed the hold
  in `msg_1c128cd09001gM8Zbnk6Z45AK6`. This is user-directed driver coordination,
  not autonomous recovery. Keep the hold until the ordered remediation and
  relevant reconciliation allow integration.

### Cleanup candidate and interrupted verification

The original LZ-185 worker completed candidate
`7f86e4e7466d76284459cf159b980cf5bfb86507` in its clean retained checkout.
Runtime `verify:lifecycle` started at Unix1794242830182 and produced an exit-137
receipt at Unix1794242936933, with `timedOut: false` and process-group cleanup
marked terminated. The captured tail showed passing tests, not a failing
assertion. This does not establish why the process was killed or a code defect.
The 600,000 ms check timeout was not reported as exceeded.

The runtime recorded `REPAIR` at Unix1794242940297 and dispatched replacement
attempt `b1616897-5aaf-4ab0-b4f9-d71f1d0ba615` at Unix1794242943950,
despite the driver coordination's intention to preserve the same worker. The
initial hold was a coordinator instruction, not a deterministic execution pause.
Driver request `msg_1c13d5a5f001mbEHlgk1l2LO39` (Unix1794243386360)
asked Architect to contain replacement activity with native controls and retain
both attempts' work. Native state subsequently confirmed plan cancellation
(version 14, Unix1794243424937), a cancelled and idle replacement, and the original candidate still
attached to its failed attempt. No source integration or activation occurred.

Architect is investigating the interruption. Scope-stop interruption being
misclassified as verification failure is a hypothesis relevant to S5-1, not a
diagnosis. Preserve the receipt and useful replacement changes. This operational
containment is driver assistance, not autonomous recovery or a completed
cleanup-policy fix. The stopped plan needs explicit reconciliation when its
ordered remediation and Justin's decision #8 permit continuation.

Architect completed its read-only diagnosis in
`msg_1c13f3625001acFF3xt45SB8hm`: quality phase passed, then the behavior-test
phase ended at Unix1794242907961 after 77,779 ms, with 154 printed passes and
zero printed failures. The later durable receipt was recorded at
Unix1794242936933. Reload/watch-stop logs overlap this interval but do not
establish causation. Final native confirmations
`msg_1c140b806001RYfh77RfltSHxR` and `msg_1c140f519001RVtDiCF0qz9Moc`
leave the plan stopped; both sessions are absent from the foreground-active map,
both checkouts and replacement dirty edits remain preserved. No resume, retry,
integration or activation was performed after containment.

## Remaining decisions and continuation

Reconciliation #5's storage identity clarification remains pending. #1 and #6
record product intent rather than a selection between the original offered
implementation options; resolve their concrete semantics when their dependent
increments are reached. Wave 1 is unblocked by #9. Continue the review's ordered
waves, with current-code symbol checks and bounded corrections.

## Wave 1 full-suite comparison

At `4b9bf98`, the unchanged-source run started Unix1794247076063 and finished
Unix1794247421691: 1,746 pass / 7 fail, 1,753 tests across 180 files, 19,332
assertions, 345.55 s. Logs: `/private/tmp/lazers-remediation-baseline-20261109/wave-1.{log,json}`.
The four baseline failures remain. Three additional failures were investigated:

- S1-1's native-activation test left installed predecessor fixture guards alive
  while disposing only its newest registration, then expected no guard coverage.
  The corrected test disposes all fixture registrations before each activation
  failure scenario. It preserves every mismatch/hold assertion and now passes
  (1 test, 45 assertions); this is a test-lifetime correction for the restored
  survivor contract, not a weaker production guard.
- Two owned-Desktop process identity tests returned observation-unavailable in
  the restricted shell. The identical tests passed with macOS process inspection
  available (2 tests, 10 assertions), without code changes. Do not label these
  assertion failures as random timing noise; this run used a different process
  inspection environment from the baseline.

This is not a claim that the entire suite is green, nor that the full suite was
rerun after the fixture correction. Wave 1's new failure was corrected and checked
in isolation; the baseline four remain open under their owning findings.

## Wave 2: F-S4-1

Confirmed both hot callers discarded every full-audit finding except exact-content
conflicts involving their selected task IDs. Admission and dispatch now call
`exactContentConflicts(taskIDs)`: proposal identity is computed once per active
project task, pairs are considered only for selected tasks, explicit relations
and retired tasks retain their prior exclusion semantics. No execution or scope
lookup runs on this path. Explicit project inspection retains the full audit.
Neither path persists scan output.

The schema migration renames `runner_audits` to `runner_conflict_scans`, preserving
historical rows. It also consolidates a legacy table recreated during an older
plugin overlap. Read-only trajectory/observability fixture checks use the renamed
table and still assert unchanged rows. This does not claim 332 MB has already
been reclaimed: retained historical scan data remains for the reclamation wave.

Checks: `bun run verify` and `git diff --check` passed; 32 store/inspection tests
passed (420 assertions), and native-runtime admission/dispatch regression passed
(1 test, 7 assertions). The wider five-file read/inspection run gave 80 pass and
only the known commentary baseline failure. A 175-task module fixture returned
identical relevant conflicts: full audit 1,354.82 ms; scoped check 4.85 ms;
0 persisted scan rows. These are fixture measurements, not live lock-duration
or installed-service observations. No native activation or disk reclamation yet.

## Wave 2: F-S4-2

Confirmed runtime safety decisions used the capped display `plans()` window.
All runtime consumers now avoid that window: live attempt conflicts, scope changes,
preparation and location retirement use the indexed active-project attempt query;
the drain pages execution candidates after its existing terminal-state filter;
cancellation checks use their renewal's mapped plans; transitive dependent
execution is a project-scoped recursive existence query. Cancellation-first,
priority and insertion ordering are preserved. This does not redefine lifecycle
states or establish the requested broader XState authority alignment.

Boundary tests use 1,005 terminal plans and more than 1,000 runnable plans. They
verify current work dispatches, pagination has no duplicates/omissions, a live
writer remains visible even on a cleanup-blocked plan, location retirement cannot
pass that owner, and a transitive dispatched dependent outside the display window
still prevents prerequisite repair. The fake native prompt host now obtains its
assigned attempt from live reservations, rather than repeating the production
window defect.

Read-only `EXPLAIN QUERY PLAN` against the production DB confirms
`SEARCH a USING INDEX runner_attempts_active_project (project_directory=?)`,
followed by a plan primary-key lookup and ordering sort. That query was read-only; no cleanup was performed. Quality checks passed; 374 store/runtime/retained-repair
tests passed with 5,999 assertions. A further 79 retained-reverification tests
passed with 925 assertions. No new behavior failures appeared. No native activation
or claim of installed scheduler recovery yet.

## Wave 2: S8-1

Removed `verifyRunnerRevision`, the second-WAL-snapshot revalidation in
`readCurrent`, both event/native-revision rejection checks in non-destructive
live reads, and their now-unused error class. Responses retain the captured runner,
native and event boundary; existing event catch-up and gap handling remain.
The legacy diagnostic projection still consumes native events destructively and
keeps its guard. Its source-change failures now receive up to three reads total
and a declared `observation_changed` RPC failure rather than an opaque defect.

Amended the original defect-asserting inventory test and two further held-read
cases to assert successful responses at the captured boundary across native events,
disconnects and DB writes. Their S8-1 comments name the corrected contract. Added
three-attempt recovery/exhaustion coverage for the guarded diagnostic reader.

Acceptance traffic test: 367 native events plus runner writes over 2,009.04 ms
(182.7 events/s), 123 successful live responses, 0 failures. Every returned event
boundary was no greater than the then-current tracker sequence; older boundaries
were observed, establishing that the test overlapped actual events with host
awaits. This is a real-module traffic test with a controlled native-host fixture,
not a Desktop production-load observation. All 58 observability behavior tests
passed (869 assertions), as did `bun run verify` and `git diff --check`.
Installed-service activation and live Desktop acceptance remain unproven.

## Wave 2: shared index and schema inventory asks (S2-4)

Added `runner_progress(plan_id,seq)` and `runner_attempts(plan_id)` together with
the declared module inventory. Re-derived the two session-index requests: current
columns already have UNIQUE constraints. Read-only production query plans use
`sqlite_autoindex_runner_attempts_2` and
`sqlite_autoindex_runner_source_quarantines_2` for `session_id=?`. Adding duplicate
indexes would increase write amplification; no duplicate was installed.

The review's minimum inventory correction is implemented: core schema version 8
adds `schema_modules(module,generation,tables_json,installed_at)`; transactional
`installSchema` skips installed generations, rejects newer module generations and
rolls back failed installation. Runner setup uses its generation; compatibility
consolidation still handles an old plugin recreating `runner_audits`. Startup logs
report undeclared/missing tables and generation drift without dropping anything.
The declared ownership map covers current task-DB DDL modules, including the
expanded handoff schema. Workspace witness tables belong to separate databases.
Advice schema installation moved to repository startup; an absent advice schema
is distinct from installed empty history. Concurrent submission and migration
rollback tests remain intact. Automatic format/lint changes accompany this code.

This does not claim all subsystems have adopted generation-gated installers:
recovery and other modules still run their existing constructors. Their missing
generation records are explicitly reported. In particular, the remaining
RecoveryJournal constructor means S2-3's zero-write-transaction acceptance is not
yet established. No new schema framework or retention deletion was introduced.

Checks: quality checks passed; 64 migration/submission/advice/store tests passed
(707 assertions). All four requested lookup shapes use indexes in fixture query
plans, and a current runner generation skips its DDL. The full Wave 2 run, at
HEAD `509e0c2` plus the recorded schema working tree, started Unix1794248840600
and finished Unix1794249169159: 1,758 pass / 9 fail, 1,767 tests across 180 files,
19,561 assertions, 328.49 s. Logs:
`/private/tmp/lazers-remediation-baseline-20261109/wave-2.{log,json}`.
Source status was unchanged through that run; process inspection was available.

Four failures match the original baseline. The five additions were investigated:
two advice fixtures assumed lazy table creation; progress-time, tool-ledger and
source-quarantine fixtures downgraded their layout while retaining a current
module generation; the delivered-outbox fixture similarly injected historical
markers after recording the migration complete. (This full run failed the `tasks/read.test.ts` advice case; the sibling
`tasks/advice.test.ts` case had been corrected earlier.)
Corrected those fixture setups without deleting tests or weakening their data,
identity, scope or timestamp assertions. All five failing cases now pass (25
assertions); the broader affected read/progress/recovery files pass 49 tests / 758
assertions. No full-suite rerun after those test-only corrections is claimed.

Native observation: the held Architect and both LZ-185 sessions remain inactive,
with the candidate and replacement changes preserved. A read-only production
schema check saw version 7 and `runner_conflict_scans` present: an earlier name
migration reached that DB, but schema version 8 had not. No explicit service
reload or Desktop acceptance of the combined Wave 2 changes is claimed.

## Wave 2 status

Dispatch audit, historical-window safety and live-read liveness corrections are
committed separately; the shared index/schema increment completes the ordered
Wave 2 code work. Remaining confirmations are installed-service activation,
native panel/scheduler observation, and the four baseline failures. Historical
scan space is retained for Wave 6. Reconciliation #5 still awaits clarification;
XState authority, record-time key redaction and post-merge worker termination
remain required in their dependent increments.

## Wave 3: F-S4-3

The stale-checkpoint path now uses `recordOnce`, comparing the latest same-scope
condition with the current JSON value inside its transaction. Unchanged facts
produce no transition or repository mutation; distinct checkpoint/input conditions
remain recorded. This compares structured data, not source-file hashes.

A 100-repeat test across two store instances leaves transition count and watermark
unchanged; changed conditions and task scope still append history. The real runtime
continuity test now repeats five drains with the same uncovered input and observes
one blocked-checkpoint transition, then records the new checkpoint and completes
renewal normally. Quality checks and the focused tests passed; the broader store
and renewal/checkpoint selections passed too.

Audited the other named event producers: `hold` already compares state, reason and
worker observation; `OUTCOME_SUPERSEDED` follows a guarded outbox state change;
a healthy sealed source guard bypasses reactivation, while restoration after a real
loss is a distinct incident. Preserved those events rather than hiding repeated
incidents through payload-only deduplication. No historical transition rows were
deleted. A post-activation native measurement of the former 110,826-row write loop
remains required; this increment establishes the code and runtime-fixture result.

## Wave 3: F-S3-1

Completed, archived predecessor sources now transition out of polling while their
rows, input/result history and explicit inspection remain available. Preparing,
active and retired transitions use the exported `architectSourceMachine` (XState),
including reactivation and retry preparation. Runner schema generation 2 adds
Unix-ms `scan_complete_at` and the native observation hint.

Re-derived the suggested native message-count check: the pinned per-session APIs
expose no message count (`experimental.session.stats` is project/range aggregate).
The adapter instead compares native `time.updated` and inbox identities/delivery
states, using the existing event stream to invalidate hints. Unchanged hints skip
history retrieval. Inputs/results skip unchanged UPSERTs while preserving sweep
membership and renewal binding; unchanged observations do not rewrite their fact
timestamps. Native activity reactivates retired sources. A first project listener
and detected stream gaps schedule one recovery sweep, covering offline changes;
changes during an awaited page keep its cache invalid without rejecting the facts
already collected. Repeated invalidations use a read-only fast path.

No second native subscription or timer was introduced: `registerProgress` forwards
activity and loss through its existing stream. Known source membership keeps worker
events off this cache's DB path. Only event types accepted by the pinned plugin
surface are registered; the client's broader content-update union was not forced
through an unsupported cast.

The broad run found a real dependency on perpetual polling: ownership changes had
relied on later source scans to refresh old-source pointers. Renewal, reassignment,
adoption and rollback now refresh reference-only notices from retained DB history
through the existing helper, without fetching old native transcripts. Retired
sources remain valid for authenticated explicit history and reconciliation.
Three fake inbox/result mutations now emit their corresponding source-change
notification; their original isolation, no-replay and receipt assertions remain.

Checks: `bun run verify` and `git diff --check` passed. Initial broader run: 483
pass / 4 fail across 487 tests. After correcting ownership refresh and event-driven
fixture inputs, 68 selected runtime tests passed (911 assertions), plus 154
store/native/progress/storage tests (1,207 assertions). New cases prove zero history
reads across four subsequent drains after retirement, durable history access,
native activity and gap recovery, no retirement over an in-flight change, and
native adapter cache misses after timestamp/inbox changes. Late mutable tool
results still update and notify their current owner. No native model was run.

These controlled observations do not close the production measurement: the former
76-sweeps/min class still needs post-activation sampling against the actual host.
No historical sources or useful worker work were deleted.

## Wave 3: S7-5

Re-located the replay and current-idle predicates in `registerProgress`. Added a
closed rejection-reason field to native observations and named the first failing
predicate for replay eligibility and both current-idle checks. No credentials or
raw native payloads are added. Existing observation Unix timestamps remain intact.

Before changing recovery policy, parameterized the review-named stream-gap test
with and without a fully synced current log. Both old-policy cases passed (9
assertions); the synced case specifically recorded `idle-replay-rejected` /
`newer-start-fence`. Log:
`/private/tmp/lazers-remediation-baseline-20261109/s7-rejected-predicate.log`.
This proves the review's hypothesized mechanism in a controlled reproduction;
it does not establish the cause of every historical native recurrence.

An exact synced replay now bypasses the redundant newer-start fence and clears
that local fence, permitting the same execution's subsequent terminal success to
confirm its zero-background report. All durable revision/start/event/input,
native identity, observer lifetime and terminal checks remain. No-log, stale,
unsynced, changed-input and changed-execution paths retain their protections.
The defect-asserting test is amended with a finding comment: current replay must
recover through terminal confirmation; absent replay still requires a new start.

`bun run verify` passed. Native progress, current-idle, recorder, idle-store and
replacement-verification behavior files: **109 pass / 1 fail**, 832 assertions.
The sole failure is the original baseline zero-background replacement-verification
case (expected accepted, remains running); it is not resolved or relabeled by
this correction. Full output: `s7-behavior.log` in the baseline directory.
Native Desktop recurrence/acceptance and post-activation rate measurements remain
unproven. No model turn was launched or worker resumed for this reproduction.

### Wave 3 full-suite comparison

At unchanged code commit `974c7d8`, the full suite ran from Unix ms
1794251686235 to 1794252062532: **1,769 pass / 4 fail**, 1,773 tests across
180 files, 19,720 assertions, 376.23 seconds. The distinct failures are exactly
the original four listed above; no new failures. The Wave 2 fixture corrections
also survived this full run. Logs: `wave-3.{log,json}` in the baseline directory.

Read-only native inspection confirmed the original Architect, original LZ-185
worker and cancelled replacement remain inactive; the Architect's last message
retains the remediation hold. Their work has not been resumed or discarded.
F-S4-3, F-S3-1 and S7-5 code/behavior corrections are complete; native recurrence
and rate measurements are still outstanding, so production symptom closure is
not claimed. No Wave 3 item required another reconciliation decision.

## Wave 4 prerequisite: F-S10-4

Read S9 and S10 in full and re-located the arithmetic by symbol. A new production
reader test supplies one unshared accepted session, one published catalog tier,
and matching complete step/cumulative usage. Before correction it reproduced
`41.324355` versus `41.324355000000004` for the same cohort. The captured failure
is `s10-three-price-before.log` in the baseline directory.

Exported the existing valuation decimal helpers and reused them for known-usage
category products, per-call monetary sums, reference-estimate category/range
products and sums, and task-valuation range sums. Rate strings remain decimal
inputs; conversion to numbers occurs at public numeric boundaries. Missing-rate,
partial-attribution, tier-selection, overflow/underflow and source provenance
contracts remain. No pricers have been merged or market-price policy changed.

The cross-consistency test now requires exact `toBe` equality between current
market cost per accepted task, reference-estimate numerator, and the known-usage
scenario's value. `bun run verify` passed; valuation, reference-estimate,
known-usage market and decision-reader behavior files: **61 pass**, 594 assertions.
Output: `s10-decimal-behavior.log` in the baseline directory. No live pricing
refresh or inference was performed; this is arithmetic/projection validation.

## Wave 4: S9-1

The short recorded-cost summary now projects the existing accounting result,
including its `missing` / `partial` / `worker-attempt-only` status, rather than
re-summing the same rows with an empty-array zero. The all-unknown defect assertion
is amended with the finding ID. Added complete-zero, partial-positive and
complete-positive cases requiring agreement between both projections. These are
legacy diagnostics; canonical market pricing and repricing remain separate.

`bun run verify` passed. Trajectory read/accounting behavior: **34 pass / 1 fail**,
249 assertions; only the original commentary/automatic-fact baseline failure
remains. Log: `s9-cost-behavior.log` in the baseline directory. No native state,
usage or price data was changed.

## Wave 4: F-S10-2

Added `unmetered` to contribution, reported-cost and Models decision schemas.
When all numeric reported measurements for a session are zero and observed usage
is positive, its diagnostic cost is null/unmetered. The classification covers
cumulative snapshots, attempt scalars and additive steps. All-unmetered totals
propagate to decision rows; mixed metered/unmetered sessions retain their known
subtotal without claiming a complete total. Zero-token cumulative/attempt zeros
remain observed zeros. Original measurements remain stored unchanged.

Tests explicitly cover 1,000 tokens/zero reported cost, zero tokens/zero cost,
all three measurement paths, mixed sessions, and decision-row propagation. Market
valuations are asserted unchanged against identical usage with a nonzero reported
charge. `bun run verify` passed. Valuation/decision reader: **39 pass**, 400
assertions; server/decision-contract integration: **40 pass**, 493 assertions.
Logs: `s10-unmetered-{behavior,integration}.log` in the baseline directory.
No subscription charge is substituted for the canonical current market value.

## Wave 4: S9-2

The short trajectory token summary now derives category values, completeness and
session coverage from the shared task-effort accounting selection. Removed its
independent native-only aggregation loop. A missing native session can therefore
use retained cumulative usage; additive-only history remains a partial subtotal;
a genuinely missing category is null. Existing public field names remain. The
panel accepts nullable category subtotals and displays available partial values
without requiring an unrelated fully observed session. Per-attempt native usage
still uses the existing native-only helper, so that helper is not deleted.

New tests remove the native sessions and exercise retained cumulative, additive
and entirely missing histories, asserting category-by-category agreement between
both summaries. `bun run verify` passed. Read/accounting: **37 pass / 1 fail**,
274 assertions, with only the baseline commentary failure. Projection/native-report
and targeted DOM render: **12 pass**, 97 assertions. `bun run build:gui` passed,
including bundle evaluation; existing ONNX CJS `import.meta` warnings remain and
are not changed here. Logs: `s9-usage-{behavior,panel,gui-build}.log` in the
baseline directory. Desktop visual activation has not been observed.

## Wave 4: S8-6

Moved retained-session selection and its truncation flag from registration fields
into each live read. A genuinely over-capacity project read still reports its
omission; a later or overlapping one-session read reports its own one-entry,
non-truncated state. No new timer, subscriber or persistence path is introduced.

The first integration run exposed two dependencies on the old union: one test
asserted 32 retained entries after 33 independent one-session reads (amended with
an S8-6 comment), and another correctly required events from a separately visible
unmanaged panel to keep invalidating it. Preserved that event behavior by retaining
interests in the tracker's existing bounded 500-session interest set, independently
of each response's 32-entry retained-state accounting. Other tracker consumers
keep replacement selection. This is not the separate S8 publisher/queue redesign;
its duplicate subscription/delivery findings remain open.

`bun run verify` passed. Live-reader/change-tracker/registered RPC behavior:
**29 pass**, 491 assertions, including overlapping scope reads and the unmanaged
event negative regression. Log: `s8-scope-behavior.log` in the baseline directory.
The controlled event-traffic test again recorded zero read failures; this is not a
Desktop performance measurement.

## Wave 4: F-S5-1

Check and phase receipts now retain an optional `aborted` flag. Signal cancellation
without a deadline timeout sets it; success classification excludes it while
process-settlement classification stays independent. Both ordinary/combined-check
and mechanical-preparation effect reconcilers retain interrupted receipts as
uncertain, rather than completing them as failed product checks. The ordinary
path detects interruption before publishing a verification result/progress fact.
Historical receipts without the flag keep their existing interpretation.

The review-named shutdown test exposed an additional acceptance-path gap: existing
Resume interpreted a verifying attempt as a worker continuation and refused the
uncertain check. The existing Resume action now recognizes an exactly bound,
settled interrupted ordinary check, preserves the verifying attempt/candidate,
retires the interrupted operation while retaining its receipt, and authorizes a
new verification epoch/receipt path. It does not prompt another worker or replay
the original effect. Other unresolved effects and uncertain process settlement
still require reconciliation. This uses the existing command/effect flow; no new
service, state vocabulary or worker-repair flow is introduced.

Amended the defect-asserting shutdown test with F-S5-1: reopen produces uncertain,
plan blocked, one verifying attempt; explicit Resume then reaches accepted with
the same attempt, two distinct check effects and the original aborted disk receipt
intact. `bun run verify` passed. Focused runtime verification/shutdown/process
suite: **21 pass**, 464 assertions. Complete artifact/check suites: **20 pass**,
115 assertions. Logs: `s5-shutdown-{focused,behavior}.log` and `s5-checks-all.log`
in the baseline directory. Retained/adoption cancellation lifecycles are not
merged into this correction; their broader recovery remains separately scoped.
The earlier native LZ-185 exit-137 incident is still not attributed to this cause
without an observed abort receipt; no historical failure is rewritten.

### Wave 4 full-suite comparison

At unchanged code commit `19bc668`, the full suite ran from Unix ms
1794252961069 to 1794253261110: **1,781 pass / 4 fail**, 1,785 tests across
180 files, 19,791 assertions, 299.97 seconds. The four failures are exactly the
original baseline set; no new failures. Logs: `wave-4.{log,json}` in the baseline
directory. All Wave 4 corrections and the exact-arithmetic prerequisite are
committed and regression checked. Reconciliation #2 follows Justin's current
market-price decision; no further decision blocked this wave. No production
history was rewritten and no native acceptance or CPU reduction is inferred from
the suite result. Native activation/observations remain outstanding.

## Wave 5: S11-1

Replaced per-entry synchronous `git check-ignore` with one asynchronous NUL-delimited
stdin query per eligible directory. Exit codes other than 0/1 still fail refresh;
all enumeration/time/file/byte limits, permissions, ignore rules and `readSource`
TOCTOU checks remain. The collection loop yields between file groups.

Initial batching exposed a second measured service-thread stall: importing the
Repomix entrypoint just for its default ignore list. Moved that load into the
existing processor worker, started before collection; the worker supplies its
pinned defaults and is then reused for packing. Worker count is unchanged. Error,
timeout and collection-failure paths terminate it. No deep package import, copied
ignore policy, new process service or new subscriber is introduced.

Measured against the same 1,249-file controlled repository:

| Run                  | Refresh ms | 20 ms ticks / expected | Delivery |
| -------------------- | ---------: | ---------------------: | -------: |
| Before               |    5924.65 |               11 / 296 |    3.72% |
| After cold process 1 |     330.47 |                15 / 16 |   93.75% |
| After cold process 2 |     342.34 |                16 / 17 |   94.12% |
| After cold process 3 |     337.54 |                15 / 16 |   93.75% |

Published relative path lists are identical across before/all after runs; longest
after tick interval was 22.08 ms. Records and rerunnable fixture driver:
`s11-perf*.{json,ts}` in the baseline directory. Both owned performance fixture
repositories were removed after measurements; result files remain.

The behavior test indexes 1,200 unignored files, requires each refresh under
5 seconds and at least 90% timer delivery across three successive real refreshes.
A single sub-half-second sample proved quantized enough that one tick could move
it across the threshold; the longer active-work sample keeps the same acceptance
threshold without an idle padding period. The unavailable-Git test removes only
its fixture's Git metadata, requires failure, and confirms the prior snapshot
remains published. Existing permission/symlink/ignore/publication tests still pass.
`bun run verify` passed; context/index and real-worktree reuse tests: **22 pass**,
162 assertions. Log: `s11-batch-behavior.log`. These are real-module controlled
measurements, not native Desktop latency or production CPU measurements.

## Wave 5: S11-4

Path selection still narrows/deduplicates candidates first. Native permission now
precedes content search for every selected path; only permitted content reaches a
compiled, escaped, case-insensitive literal matcher. Removed full-source lowercase
copies. Snapshot ownership, as-of-refresh semantics and response counts remain.

Updated the two tests that previously expected content filtering before permission
with finding comments; they still assert exact native principal/workspace/path
bindings, deduplication and scoped results. Added literal metacharacter/case tests
and a matcher observation proving that a denied file's content is never visited.
`bun run verify` passed; context and real-worktree reuse: **24 pass**, 166
assertions. Log: `s11-search-behavior.log` in the baseline directory. This closes
the selection/permission/allocation defect; no live Desktop memory claim is made.

## Wave 5: F-S14-9

The main-process layout service lazily creates and reuses its ELK worker/API,
terminates it in the existing disposer, and recreates it after failure. An idle
worker death is reported once to the next caller; an in-flight death rejects its
pending request through the existing adapter. Pending requests now also reject
on an unexpected zero-code exit. Cancellation still rejects obsolete layouts.
No layout work moves to the renderer. Geometry, cache keys, bounded IPC and
accessible failure fallback are unchanged.

Tests require two distinct layout keys to retain one thread ID; a real worker
terminated between calls produces a rejected second call and a successful third
on a new thread. Disposal is checked and all test services are disposed even on
failure. `bun run verify` passed; layout tests **9 pass**, 42 assertions; GUI
build and renderer-global-free bundle evaluation passed (existing ONNX
`import.meta` warnings remain). Logs: `s14-worker-reuse.log` and
`s14-worker-gui-build.log` in the baseline directory.

A separate real-module probe over six distinct keys measured 96.94 ms initially,
then 4.63 / 4.02 / 3.43 / 3.21 / 3.19 ms, all on thread 1. Results and driver:
`s14-layout-perf.{json,ts}` in the baseline directory. This Bun-hosted worker probe
is not an Electron Desktop CPU measurement; the review's 0.2–0.6 ms warm figures
are not claimed as reproduced.

## Wave 5: S8-2

Projection-source SQL now selects at most 10,001 newest transitions, attempts and
check rows before materialization. The extra row determines omission flags; public
history keeps 10,000 rows in chronological order. Snapshot responses expose
optional additive coverage fields (all current responses fill them), and Radar's
existing work-truncated flag includes history omissions. Removed the post-hoc
volume exception. The RPC passes cancellation through; the reader checks it
before opening storage, between bounded queries and before final projection
readback. This is cooperative cancellation, not interruption of a running SQLite
statement.

Added a 10,050-transition project test for latest-window ordering, boundary,
omission flags, schema acceptance and pre-abort. Amended the existing broad-read
failure assertion with S8-2 while retaining its targeted read/paging/isolation
checks. `bun run verify` passed. Observation readers/RPC and Radar projection/
presentation: **46 pass**, 482 assertions. Log: `s8-bounded-history.log`.

A separate **read-only production-DB module probe**, with no native session/model
calls, returned a usable Project snapshot in **1,278.10 ms**: 10,000 transitions,
188 attempts, 969 checks, truthful transition/work truncation, no volume exception.
Script/result: `s8-production-snapshot.{ts,json}` in the baseline directory.
This closes unbounded result materialization and the deterministic volume failure;
it does not establish that a 1.28-second synchronous read is an acceptable final
service-loop latency. The remaining query/index/projection work is not claimed
fixed, and no Desktop CPU result is inferred.

## Wave 5: F-S5-3

Retained verification advancement, including dependency setup, now runs as a
non-overlapping background activity in the existing verification-activity registry.
The drain admits it and continues through unrelated plans rather than awaiting
an installer. Existing operation/generation ownership, isolated resource callbacks,
check identities and result acceptance remain. The existing operation-run map
prevents duplicate admission; no timer or second execution service is added.
Completed advance activities mean the step settled, never that a check passed.

Cancellation aborts and joins both the parent advance and its actual check before
reconciling resources. Parent cancellation reaches task and combined setup through
the existing controller; shutdown's owned-activity sweeps cover the parent too.
Unexpected advance errors go through the existing retained hold path before the
activity settles. Normal check results and process-settlement receipts remain the
only check authority.

Extended the held-installer test to require the scheduler drain itself to return
before release, alongside the existing independent RPC assertion. Receipt-cut
fixtures now select the actual `retained` check activity rather than the new void
parent step, and wait for real admission instead of 20 synchronous ticks. The
injected-failure fixture waits for the durable held state after asynchronous
admission; all original cleanup/ownership assertions remain. Its timeout timer is
cleared.

`bun run verify` passed. Focused cancellation/setup: **20 pass**, 279 assertions.
The broad unchanged-production-source run covered 412 tests: all **333 runtime
tests passed**; one of 79 retained tests exposed the submission/completion fixture
assumption. After that test-only correction, the complete retained suite passed
**79 / 79**, 912 assertions. Logs: `s5-setup-{focused,broad,retained-final}.log` in
the baseline directory. No full-suite rerun or native Desktop setup observation is
claimed yet. This removes the awaited installer from the drain; remaining
synchronous dependency-tree walks are not claimed eliminated.

A read-only native check during this increment reconfirmed the Architect and both
preserved LZ-185 sessions inactive under the existing maintenance hold. No worker
was resumed, prompted or discarded.

## Wave 5: S8-3

Radar now selects progress identities through a derived observation-recency index
before fetching payloads. Runner schema generation 3 backfills the exact existing
ordering once, then maintains it transactionally for inserts and legacy payload
updates. Recently coalesced observations remain visible after 5,000 later rows;
selecting by insertion sequence alone would violate that existing contract.
Read-only older schemas retain the legacy query until their normal migration.

Migration preserves original facts, timestamps, payloads and recovery-change
counts. Derived-only updates do not emit extra recovery facts or observation
revisions. A legacy payload update refreshes the index while emitting exactly one
of each original change notification. This is an index, not a new evidence or
acceptance authority.

`bun run verify` passed. Migration, observation readers/revisions, recorder,
storage and runner-store tests: **94 pass**, 1,239 assertions across six files.
Log: `s8-recency-behavior.log` in the baseline directory. A separate 25,000-row
fixture probe selected identical 5,001 rows: **117.00 ms before, 0.63 ms after**;
EXPLAIN uses the covering `runner_progress_plan_recency` index. Probe and result:
`s8-recency-perf.{ts,json}`. This is not a production activation or Desktop CPU
measurement; the native maintenance hold remains in place.

## Wave 5: F-S13-1

ModelCache retains successful file identities for its process lifetime. Repeated
ensure/family switches skip hashing only when the same regular file has the exact
previously verified identity. First use in a new cache instance and every identity
change still hash; mismatches invalidate the cached identity before verification.
Open-without-following-symlinks, before/after identity checks, pinned checksums,
atomic downloads and read-time checks remain intact.

A mailbox transport failure now keeps the resident GPU model and exact lease,
reports the connection interruption and retries on the existing tick. Only an
explicit broker ownership-loss response enters unload/reattach recovery. A
successful subsequent poll restores the ordinary status without a new allocation.
User keep-alive and feature settings are unchanged; disabling still disposes.

The real renderer lifecycle fixture now distinguishes three consecutive transport
failures (no disposal, detach, reattach or duplicate allocation) from confirmed
ownership loss, including the existing detach-timeout recovery. Cache tests count
actual file read streams: first use hashes, two unchanged ensures do not, a new
instance hashes, and same-size corruption hashes and downloads a replacement.
Existing symlink/replacement/cancellation and failed-disposal coverage remains.

`bun run verify` passed. Cache, runtime fixture, lease, lifecycle and broker:
**36 pass**, 226 assertions across five files. GUI build and bundle evaluation
passed, with the existing ONNX `import.meta` warnings unchanged. Logs:
`s13-behavior.log`, `s13-verify.log`, `s13-gui-build.log` in the baseline directory.
No physical GPU/Desktop recovery observation is claimed; this fixes the proven
source-level reload/hash loop without relaxing model integrity or lease fencing.

## Wave 5: F-S10-3 re-derivation (open)

Current code already projects slim decision fields and hashes serialized rows
incrementally; the review's whole-raw-history double-serialization description
does not fully apply at this HEAD. The valid regression test preserves complete
decision history beyond 15,000 facts and the former 64 MiB raw-payload boundary.
No smaller arbitrary limit was restored.

A read-only production probe still measured a serious synchronous blocker:
24,739 progress facts, 41,676,921 bytes of final decision projection, captures
**12,428.80 / 7,948.91 / 7,979.67 ms**. The output byte count was measured after
the timed read. No native model calls or DB writes occurred. Probe/result:
`s10-capture-perf.{ts,json}` in the baseline directory. The finding remains open;
incremental digesting alone did not resolve the event-loop latency.

### F-S10-3 measured access-path correction

CPU profiling attributed about **95%** of capture time to SQLite `all`/`get`,
including 77.3% in paginated progress reads and 14.5% in the separate malformed-JSON
count. EXPLAIN showed every page using the project/dedupe index and a temporary
sort. A read-only query comparison over the same 24,739 facts measured
**5,015.38 ms** on that path versus **136.95 ms** seeking the sequence primary key.
Artifacts: `s10-capture-profile.md`, `s10-query-plan.{ts,jsonl}`.

Decision capture now explicitly seeks sequence order and counts malformed records
inside that same pass, guarding JSON projection before extraction. The existing
512-row pages, cancellation checks, project/task association, complete-history
contract and incremental digest remain. No new row gate or truncation was added.
A regression with 512 malformed records followed by a valid record verifies that
pagination advances, reports the exact excluded count and preserves later facts
and stable snapshot identity. The >15,000-fact / >64 MiB raw-history test remains.

`bun run verify` passed. Decision and observation-ledger tests: **19 pass**,
247 assertions (`s10-query-behavior.log`). A repeated read-only production probe
returned the same fact count and final serialized size in
**2,432.70 / 1,219.35 / 1,226.43 ms** (`s10-capture-after.json`), versus the prior
12,428.80 / 7,948.91 / 7,979.67 ms. This removes the measured repeated-scan defect,
but **F-S10-3 remains open** for synchronous growth and repeated price-snapshot
parsing. A 1.2-second warm main-thread read is not claimed acceptable. No production
data was changed, and no native Desktop CPU improvement is claimed.

## Wave 5 checkpoint suite comparison

At `dba860a`, full suite started **1794255690814** and ended **1794255982357**
(Unix milliseconds): **1,787 pass / 7 fail**, 1,794 tests, 181 files,
19,787 assertions, 291.50 seconds. Logs and metadata:
`wave-5-checkpoint.{log,json}` in the baseline directory.

The four original failures remain. Three additional failures were stale S8-2
expectations that oversized snapshots throw: `src/observability/topology.test.ts`,
`test/observability/registered.test.ts`, and
`test/trajectory-panel/targeted-render.test.ts`. Updated only that expectation to
assert the 10,000-row window and truthful truncation; the history-free topology,
targeted RPC paging/isolation and targeted-rendering assertions remain intact.
Each amended assertion names S8-2. These three files now pass **6 tests / 78
assertions**, and `bun run verify` passes. Logs:
`s8-history-fixtures.log`, `s8-history-fixtures-verify.log`.

This is a full seven-failure checkpoint plus a passing targeted correction, not
a claim of a fresh full-suite four-failure result. Wave 5 remains open for heavy
synchronous Git operations and the remaining decision-capture growth/latency.

## Wave 5: F-S5-11 / F-S3-4 asynchronous status observations

Added the review's `gitAsync` transport using the existing command timeout,
output bound, environment and non-interactive Git policy. All runtime
`status --porcelain*` calls now await it: retained verification, adoption,
reconciliation and cleanup. Untracked-path semantics remain unchanged; none of
these consumers can safely ignore untracked work. The unchanged synchronous
`artifactUnchanged` helper also now disables credential prompting.

Adoption publication obtains status before its write transaction and rechecks
the durable owner/version inside it. Branch/HEAD checks remain inside that
transaction. Cleanup rechecks cancellation after the awaited observation before
removing anything. Candidate reconciliation performs status checks sequentially,
without spawning one process per native workspace concurrently. No new timer,
daemon, scheduling authority or acceptance rule is introduced.

A deliberately slow real Git alias verifies that the event loop's timer runs
while the command is pending; native Git failure still rejects with its actionable
message. This is a responsiveness behavior test, not a throughput benchmark.
`bun run verify` passes. Final artifact, adoption, retained-verification and runtime
tests: **454 pass / 0 fail**, 6,743 assertions across four files, 167.18 seconds.
Logs: `s5-async-status-final.log`, `s5-async-status-verify.log` in the baseline
directory. The earlier retained-only increment passed 429 tests before the other
status call sites changed; the final run covers all current changes.

**The finding remains open for `merge-tree` / `commit-tree` and their synchronous
artifact callers.** Small `rev-parse` / ancestry reads remain synchronous, as
recommended. The change does not claim native Desktop CPU results or completion
of every Git event-loop blocker.

### F-S5-11 / F-S3-4 artifact operations

Artifact combination, reviewed virtual-baseline merges and candidate snapshots
now await the same `gitAsync`: `merge-tree`, `commit-tree`, staging, write-tree
and snapshot path enumeration run outside the service loop. Small immutable
ancestry/identity reads remain synchronous. Synchronous and asynchronous path
enumeration share the same commands and result reducer, not separate scope rules.
Fixed synthetic commit dates, ancestry checks, scope exceptions, conflicts and
the prohibition on staging a shared checkout remain unchanged.

Plan-level human acceptance computes its immutable combined artifact before the
command transaction; the existing version/owner CAS still decides publication.
Verification rechecks current authority after snapshot work and before publishing
it. Finish rechecks accepted inputs after combining. Dispatch checks its owner,
control epoch, plan definition and target-node state after awaited dependency work.

The first dispatch recheck incorrectly compared the whole plan version and caused
14 local regression failures (**440 pass / 14 fail**, 172.14 seconds). A valid
sibling dispatch advances that version, so the guard suppressed parallel work.
Removed that overconstraint; the relevant owner/control/definition/node predicates
preserve cancellation without serializing siblings. The original failed log is
retained as `s5-async-artifacts-broad.log`. All eight targeted parallel/cancellation
tests then passed (157 assertions), and the complete four-file regression rerun
passed **454 / 454**, 6,743 assertions, 167.29 seconds
(`s5-async-artifacts-final.log`). No failed assertion was weakened. `bun run verify`
passes; artifact tests now await the same results/rejections as before.

A real-module two-branch probe held Git's merge open behind a temporary fixture
barrier: **10 periodic JavaScript callbacks ran while Git was held**; JavaScript
released it before completion; both branch contents appeared in the combined
artifact; checkout HEAD stayed unchanged; fixture removal was confirmed.
Driver/result: `s5-async-combine-probe.{ts,json}` in the baseline directory.

This completes the review's two repository-size operation classes in the runtime
(status plus merge/commit-tree) without converting all metadata reads or adding
a new worker service. Other synchronous filesystem/diff work and the separately
identified verification-probe store are not claimed offloaded. Physical Desktop
CPU and responsiveness still need native observation after activation.

## Wave 5 final suite comparison and remaining work

At `af0477f`, the complete suite started **1794257181431** and ended
**1794257469299** (Unix milliseconds): **1,791 pass / 4 fail**, 1,795 tests,
181 files, 19,828 assertions, 287.82 seconds. The four failures are exactly the
original pre-edit set: commentary/tool separation, replacement idle verification,
trajectory history selection, and native trajectory live delivery. **No new
full-suite failures remain.** Artifacts: `wave-5-final.{log,json}` in the baseline
directory. This supersedes the earlier seven-failure checkpoint; those three
additional stale broad-history assertions were corrected and remain covered.

Wave 5 closes the bounded source-refresh/search, Radar recency, bounded snapshot
materialization, retained-setup drain coupling, ELK worker reuse, runtime heavy-Git
classes and inference transport/hash-loop corrections at module/test level.
**F-S10-3 remains open** for synchronous decision-capture growth/latency and price
snapshot parsing. Synchronous dependency-tree walks also remain; physical Desktop
CPU/GPU observations after activation are still required. No whole-project
production-readiness claim is made.

### Wave 6 candidate inspection

Preserved worker commit `7f86e4e7466d76284459cf159b980cf5bfb86507` and both LZ-185
attempts. Read-only native inspection again found Architect and both workers
inactive under the ordered-remediation hold; a separate native active-session
query returned zero active sessions. No model prompts or resumes were sent.

The retained candidate contains useful canonical sibling-worktree allocation,
cleanup retries and cancelled-retained-workspace work, but it cannot land unchanged:
its `assertWorktreeQuiescent` still rejects an authoritatively missing session and
unknown background observations, and `retireCleanedWorktreeLocation` still uses
the display-limited `plans()` query. These contradict F-S3-2, the now-corrected
F-S4-2 ownership queries and Justin's reconciliation #8. The candidate is **not
accepted or discarded**; reconcile its useful changes with those current contracts,
amend the defect-asserting cleanup tests, and preserve active/dirty/unmerged work
before any native reclamation. No worktree or branch was removed in this pass.

## S2-4 activation incident: stale native import (2026-11-10)

Justin reported that Desktop had no loaded plugin. The existing 2.2.6 service
(PID 83218) repeatedly failed plugin loading with `Export named
'installTaskAdviceSchema' not found` in `src/tasks/advice.ts`. That export exists;
a fresh Bun process imported both it and the complete plugin successfully.
Supported `location.reload()` at zero active native sessions did not clear the
failure; an actual Tasks RPC returned `rpc.unavailable`. Offline test results had
not established live activation, and that missing check left the broken host
unresolved until this report.

Restarted the same installed OpenCode 2.2.6 executable through its supported
`service restart` command. No custom service, model prompt, provider change or
task resumption was introduced. The replacement service is PID 83271. Actual
registered calls then confirmed:

- OpenCode plugin inventory: `lazers`, server and GUI features present,
  `state.status: active`.
- Tasks: 175 project records; sample references LZ-201/LZ-200/LZ-199, 53 ms.
- Source fence: current registration in the replacement process.
- Live Radar: 120 ms; scheduler scheduled with 10 participants, 10 sessions,
  9 managed sessions.
- Models settings: successful registered read.
- Local inference settings: enabled, with questions/decisions/review/dictation/
  read-aloud all still enabled. This is not a GPU-residency observation.
- Native active-session inventory remained empty after these checks.

Computer Use explicitly reported macOS locked twice. Unlock was requested;
physical Desktop panel rendering and the resident-model indicator remain
unverified until it is available. Server recovery is observed; complete visual
acceptance is not claimed. No source workaround for the stale host cache was
needed, and no tasks, worker worktrees or credentials were discarded.

### Desktop follow-through after unlock (2026-11-10)

Computer Use reached the actual window after unlock. The renderer remained on
OpenCode's loading logo despite the healthy registered service; Cmd-R did not
change it. OpenCode → Restart restored the native window and its accessible web
content. No worker was resumed and no model/provider settings were changed.

Observed through native Desktop controls:

- Tasks rendered project task groups, state filters and selected task details.
  Historical records still report waiting/unknown activity; rendering does not
  establish that those attempts are currently executing.
- Radar rendered its managed session monitor. It still reports incomplete native
  event coverage and unavailable observations for historical workers. This is
  unresolved telemetry/reconciliation work, not a clean live-monitor acceptance.
- Models rendered saved UI/Systems/Small-task routes as OpenAI Luna Max. Its
  comparison initially stayed loading; one native Refresh produced the actual
  chart, selected-model cost summary and collapsed details. Automatic initial
  loading remains unproven; manual refresh was driver assistance.
- The LFM3 indicator briefly changed from available to error and back during panel
  navigation. Settings then reported chat/speech ready, resident model `chat`,
  with d1 loaded on demand. Clicking the existing Run locally control returned
  **local GPU ready.**, with **19 input / 4 output tokens**. This proves one real
  local inference request through Desktop; sustained recovery is not established
  by that successful request.
- Trajectory mounted but LZ-172 history failed. Recapture repeated the same error;
  the native log identifies `trajectoryHistory` rejecting with **Trajectory
  history exceeds the bounded capture size**. The existing whole-capture limit
  in `src/trajectory/history.ts` is distinct from the corrected S8-2 snapshot
  table window. LZ-172 remains unreadable and requires a proportional history
  paging/capture correction; repeated recapture does not fix it.

Service/plugin activation and Desktop rendering are now observed. Remaining
Radar coverage, automatic Models loading, history volume handling and inference
status flapping are not closed by this recovery. The ordered remediation hold,
all retained attempts and useful work remain intact.

## F-S4-3 live recurrence: stale continuation starves the scheduler (2026-11-10)

The native task query returned 22 unfinished tasks (12 queued, eight recorded
running, one verifying, one blocked), while native active sessions were empty.
Read-only DB inspection then identified renewal
`cebeac03-de8e-482c-8583-b939943569d6` stuck in `creating` with **Architect
continuation changed during renewal**. Recovery runs before the plan loop, so
this exception prevents ordinary task advancement. The lease/timer remain alive;
that does not establish useful scheduling. The earlier attribution to task-level
idle holds was incomplete: this project-wide poison renewal must recover first.

The current durable owner had previously received plans whose continuation rows
still named older Architects. `transferArchitectRenewal` treated that historical
row as a second ownership authority. Justin's reconciliation #4 already selects
the durable owner as authoritative. The correction updates the existing
continuation from its actual historical session inside the same fenced atomic
ownership transfer, preserving its generation and prior mapping for rollback.
It removes the redundant predecessor equality veto; project, current-owner,
renewal-phase, continuity/input and native successor checks remain unchanged.
No SQLite production mutation or replacement worker is used to repair this data.

An isolated real-SQLite runtime regression reproduced the exact live exception
before the fix. Afterward renewal commits, archives the old Architect, delivers
its successor handoff and preserves the same busy worker attempt. Related
multi-plan ownership, retired-predecessor and input/archive race tests pass.
The full runner checks and native post-restart observations follow below.

Validation: `bun run verify` passed; the full runtime plus shared scheduler suite
passed **351 tests / 5,525 assertions / zero failures** in 106.04 seconds.
Artifacts: `/private/tmp/lazers-scheduler-owner-{verify,tests}.log`.

Before the requested restart, OpenCode's source watcher activated the edit.
The previously stuck renewal became `committed` with `error: null`; its native
successor `ses_4c6f19ce976846259c93b62d29188a71` was observed running. Native
transitions recorded outcome admission, and the successor executed an inspection
call. This proves scheduler-driven renewal and Architect activation, not task
completion. It was automatic source-watcher activation, not an isolated-server
launch or a manual database correction. Post-restart task progress still needs
observation.

### S8 archived monitor read regression (2026-11-10)

After supported service restart and Desktop Restart, the old Architect window
remained open. Both `topology` and `currentActivity` rejected its archived actor,
turning the whole task view into unknown activity even though the native session,
project and read permission still existed. Archival is execution lifecycle, not
read authorization. Removed only the archived-actor rejection in these read-only
paths; native permission, exact actor/project identity, location and worker
binding checks remain. Mutation/start authorization is unchanged. The updated
real-SQLite registered tests failed on both paths before the correction, then
passed **22 tests / 296 assertions** after it. `bun run verify` passed.

The restarted service reported one shared scheduler timer and **zero errors**
after 1,990 process-wide job runs. This is scheduler activity, not proof of task
delivery. Restart interrupted the automatically woken Architect; the driver
submitted the user's authorized roadmap continuation in Desktop, explicitly
lifting the prior remediation pause for recovery and preserving retained work.
That is recorded driver assistance. No direct DB repair was performed.

### Post-restart execution observation (2026-11-10)

The successor initially kept processing historical source-change notices and
restated the old hold. The retired predecessor forwarded the new user instruction
through native OpenCode, but it was still pending as a queued synthetic input.
At Unix ms **1794332539511**, native inbox inspection found that exact recovery
input pending. The driver used OpenCode's existing `session.inbox.update` to
change only its delivery from `queue` to `steer`; readback at **1794332539524**
confirmed `steer`. No input text/history was deleted and no replacement prompt
was created. This is explicit driver assistance, not proof that historical-notice
triage or user-input forwarding priority is autonomously correct.

Architect then resumed LZ-185 through LAZERS. Native transitions show:

- **1794332618242**: plan `RESUME`, cancelled → running.
- **1794332618243**: `ATTEMPT_RESUMED`, existing attempt
  `b1616897-5aaf-4ab0-b4f9-d71f1d0ba615`.
- **1794332619041–1794332619170**: intended/completed native prompt effect for
  that same attempt.
- **1794332648231**: native active inventory contained both current Architect
  `ses_4c6f19ce976846259c93b62d29188a71` and retained worker
  `ses_3ce9e48f2186411685ec6afa72b79389`.
- **1794332648239**: registered task read reported LZ-185 running, with its
  second attempt running. Original failed attempt and candidate `7f86e4e` were
  still recorded; the resumed attempt retained its prior usage and tool history.
- **1794332648245**: restarted process scheduler reported one timer, 33,032
  process-wide job runs and **zero errors**. These totals include reconstruction
  jobs; they are not task counts or throughput measurements.

Desktop was navigated to the current Architect through its native subagent
selector. Work execution has resumed; this does not establish that LZ-185 is
finished, that downstream dependencies have integrated, or that the eight old
idle-lineage holds are reconciled. Those remain visible recovery obligations.
The global renewal poison and archived-view read regression are fixed and tested.

## S8 task activity: archived workers are known, not unknown (2026-11-10)

Native inventory at **1794332917581** confirmed three executing workers:
LZ-185, LZ-193 and LZ-194. The Tasks activity RPC reported them active, while
nine older waiting records were unknown. All nine native sessions were archived,
with exact attempt/session/workspace identities and readable empty approval and
shell inventories. `matchesCurrentWorker` rejected solely on archival. That is
an execution lifecycle fact, not absent telemetry. Removed that read-only veto,
returned the archive flag and rendered inactive archived workers as **Worker
archived**. Actual active execution still wins that label; archival does not
fabricate inactivity. Identity, native permission, project/workspace and stable
observation checks remain intact. No scheduling/admission authority changed.

The Running and Queued query filters also included blocked plans, hiding the
real execution among old holds. They now exclude blocked plans; those remain
available under Blocked/waiting and Open. Existing raw node lifecycle and hold
history are preserved. Updated paging tests include independent genuinely queued
and running controls, with blocked-plan negative cases. Both RPC and filter
regressions failed before the fix. Afterward **44 tests / 446 assertions** passed
across registered RPC, query paging, panel state, labels and the real rendered
Tasks panel. `bun run verify` passed. Logs:
`/private/tmp/lazers-worker-status-{before,after,verify}.log`.

The post-change registered activity probe returned **zero unknown results for
all 12 checked attempts**: archived workers were known inactive, LZ-193 was
active, and LZ-185/LZ-194 were then inactive as execution progressed. These are
point-in-time foreground observations, not completion claims. Artifact:
`/private/tmp/lazers-task-activity-after.jsonl`. Desktop reload/visual acceptance
was interrupted when Computer Use explicitly reported macOS locked; unlock was
requested. No model work was interrupted to refresh the window.

### Retired Architect session cleanup

The complete native project inventory contained 524 unarchived sessions, of
which six were Architects (the rest were implementers/helpers/auditor). Preserved
current Architect `ses_4c6f19ce976846259c93b62d29188a71`. Rechecked native activity
before each update and archived the other five via `session.update`, then
confirmed their native archive timestamps. History and worktrees were retained.
Confirmed receipts at **1794332862101–1794332862122**:

- `ses_e6f007c15ffe1HH5nmeqvV4UEA` — durable XState task runner.
- `ses_e6edbea90ffd9ylQrwEaEtxWVQ` — Repomix integration.
- `ses_e6eb29584ffe8HLfTVz6CBw5qI` — task reconciliation and planning.
- `ses_e6e0e6239ffdtzIePMeJ1sHA4l` — attempt trajectory and usage.
- `ses_5c1563b654ed441990b217eb2006ef2f` — prior persona-dispatch Architect.

Receipt: `/private/tmp/lazers-archive-retired-architects.jsonl`. Earlier renewal
predecessors were already archived; the inventory does not support a claim that
50 unarchived Architect chats were deleted. Unrelated helper sessions and worker
history were not bulk-archived. Longstanding non-renewed/manual Architect chats
had no automatic retirement path; this cleanup is user-authorized maintenance,
not proof that such retirement is automatic.
