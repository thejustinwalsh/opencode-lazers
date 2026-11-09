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
