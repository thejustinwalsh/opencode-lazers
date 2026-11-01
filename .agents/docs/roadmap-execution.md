# Roadmap execution

Started 2026-11-01 from `design/roadmap.md`. This is a continuation map, not
acceptance evidence. Runtime records remain authoritative for current status.

Research and reviews run in native OpenCode sessions; implementation runs in
LAZERS. Do not use an external Codex CLI review lane. The attempted CLI review
failed on its local configuration before reviewing anything and was not retried.

## Phase 1 — retain usable operation and investigation

| Work                                             | Runtime reference                                  | Done boundary                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Existing Architect lifecycle repair              | LZ-28; plan `8253ff59-57a5-45fd-8847-acd971438af8` | Queued native input and durable decision/question handoff are safe; original exact-artifact native gate remains.                |
| Native trajectory privacy repair                 | LZ-31; plan `fdba0229-dbe5-4ebf-8fb4-0c39c1e1390c` | Private canaries absent and safe visible activity retained at the real report boundary.                                         |
| State filters and exact historical navigation    | LZ-32; plan `c4be742b-4d11-485f-a657-48bbbd0cd554` | Independent scope/state controls and selected task reference/all attempts in closed or mounted Trajectory, observed in Desktop. |
| Operational identities and evidence-linked flows | LZ-33                                              | Scoped native identities/routes/states and typed flows, no transcript polling or invented traffic.                              |
| Stable SVG/ELK Radar                             | LZ-34                                              | Actual operational map, unchanged-topology updates without relayout, real native flows and off-renderer layout proof.           |

LZ-33 precedes LZ-34 in plan `b0eb89b4-a071-49e2-a238-c474d53cc42f`.
That graph waits for integrated LZ-31, LZ-32 and LZ-35 plans, then consumes the
reviewed checkout. Initial privacy/history work uses isolated native workers.
All new plans inherit the configured implementor; nodes select Systems or UI
personas independently of the model.

### Existing lifecycle lineage

The unsafe `e127d1a` candidate was **not activated or accepted**. The original
plan was reassigned to this Architect, its verification stopped through runtime,
and its original attempt/session/workspace resumed for repair. Candidate,
history, usage and original acceptance remain. A supported native instruction
entry `lazers-lifecycle-review-repair-20261101` was installed and read back on
`ses_930ecf3fd619489993f8b98167853ac1` before resume. It points to the retained
review/reproducer and requires native synthetic-admission races and durable
decision/question handoff. Do not create a replacement task or waive native proof.

The subsequent automatic repair after `8c8f86c` was caused by stale verification
receipt selection, not a failed current implementation check. The user's main
fix `2536084` is preserved and was activated through supported public reload
before LZ-32 returned. LZ-28 remains unfinished: disabling renewal is not delivery.
Its latest work was retained stopped while native investigation evaluated
durable late-input/outcome reconciliation and visible archival. An atomic
admission fence is one stronger design, **not a task requirement**; absence of
that primitive alone does not establish unsupported renewal. See
`evidence/architect-context-lifecycle/upstream-gap.md` for the corrected boundary.
The user clarified “Preserve work, honor cancels”; original LZ-28 resumed in the
same retained latest attempt with the source-supported reconciliation brief at
`evidence/architect-context-lifecycle/reconciliation-plan.md`. Renewal/archival
and exact-artifact native proof remain unfinished.

LZ-32's initial native source review found one compatibility regression: legacy
omitted-state queries lost failed/exhausted tasks. Its same original attempt was
explicitly resumed to repair both readers and tests. Do not activate the initial
`b49116e` candidate or waive the native gate. After review of the correction,
activate the candidate and ask the user to perform the agreed Desktop check.
The user subsequently observed correct filtering, historical/all-attempt
navigation and narrow wrapping, but Tera found misleading active/total fractions
in history views. LZ-32 repaired that presentation issue in its same attempt.
The user then explicitly passed `b21e3e30309616713a206278de7b5011cb7f7953`,
activated by merge `73f7783`, with fresh corrected visuals and exact LZ-9 mounted
navigation; Tera cleared its blocker. Complete evidence is in
`evidence/task-history-navigation/native.md` at `d933204`. Task `native-usable`
and combined `native-history` human evidence have now been recorded against that
exact artifact. Original attempt and combined plan passed runtime acceptance;
LZ-32 is integrated v25. The native registry and a subsequent filesystem check
confirm its owned worktree was removed without force. No duplicate activation
was performed.

Stable live Trajectory is now LZ-36 (`68a72431-87af-4bce-8e7b-77f430aeb100`),
plan `1fab1396-5f6b-45cc-a148-5eff48182ed9`. Its first isolated worker is running,
attempt `83daf09a-0112-484e-af40-57ff1ff6e554`, after LZ-32 integration. Actual
observation-file conflicts with Radar remain serialized through runtime.
It preserves loaded history/disclosures/reading anchor while status/progress
refreshes independently; repeated status and captured-page reads must add zero
native context loads. Existing default inspection cursor behavior remains.

### Privacy review hold and correction

LZ-31 returned runtime-accepted `2fff6bb`; task and combined privacy/full/quality
checks passed. Independent review then reproduced two remaining leaks in its
disposable fixtures: `safeToolContent` joins separate JSON parts before semantic
filtering, and structured strings bypass omission at exhausted recursion depth.
Both private multipart and depth-string canaries remained. No application data
was used. **Do not merge/integrate this candidate alone.**

LZ-35 (`bde43cbd-4ecc-4385-8bca-94de50fddab0`) is the minimal review-repair
supplement, plan `6a7c2c02-31b5-4a7b-8733-1384b6beeba0`, based directly on
`2fff6bb` in an isolated worker. It preserves LZ-31's record/history and requires
real-report multipart/depth variants with positive safe siblings. The Radar
schedule explicitly waits for this correction's integration too. Review and
merge only the corrected descendant, rerun relevant checks on the resulting
checkout, then record both accepted ancestor artifacts through runtime.

LZ-35 returned `15eff84`. Independent focused checks passed (35 tests / 239
assertions), original audit and both residual reproducers now omit their private
canaries while retaining safe summaries, quality passed, and the independent
full suite passed (380 tests / 3,505 assertions). Native OpenCode review found no
blocking findings; the corrected descendant was merged, and clean integrated
snapshot `2536084` passed GUI build, 382 tests / 3,533 assertions and quality.
Both privacy plans are now integrated v9. Native registry/filesystem checks
confirmed both owned worker trees absent after non-forced cleanup; the separate
clean verification tree was removed natively too. Evidence is in
`evidence/trajectory-privacy/native-review.md`.

### Remaining Phase 1 work

- Stable live Trajectory is executing as LZ-36 above. Native disclosure/reading
  continuity remains a required future observation, not inferred from source or
  read-count tests. Radar's integrated-plan prerequisites are now satisfied;
  its actual observation/runtime write conflicts still serialize through runtime.
- Renderer responsiveness remains open; LZ-14 remains cancelled. Retain its history,
  inspect captured stages and establish the actual blocking boundary before
  repair. Keep local inference enabled. Ownership was reassigned for investigation,
  but execution was not resumed. The explicit human cancellation in the retained
  `019-desktop-inference-isolation/triage.md` prohibits restoring/refining that
  abandoned refactor/stash. The newer roadmap authorizes the responsiveness goal,
  not an unproven root-cause claim or automatic resurrection of that implementation.
  The matched 2026-11-01 freeze below now supplies a stalled-run/PID baseline,
  but not an application-level root cause. Establish a compatible bounded repair
  and discriminating verification before requesting execution.

Independent native investigation `ses_e684cfd22ffeA75L4NDI0b8iwj` found a
diagnostic defect, not a freeze cause: active lag records mix renderer-uptime
elapsed values into request-relative spans and misuse lag magnitude as event
delta. LZ-37 (`4971ffe9-9d50-49cd-bdd7-775ffc681c39`), plan
`8332f91a-b697-4697-993e-8be4740ed9d6`, is admitted independently to correct only
these trace clocks/correlation boundaries. Production timer-path fake-clock
regressions, terminal/idle attribution, existing lifecycle/privacy tests and
full/quality/GUI build are required. No engine/settings/provider/transport change,
Desktop reload, cancelled-refactor revival or responsiveness improvement is
authorized by that correction. See `evidence/renderer-trace-clocks/investigation.md`.

During local task review, ordinary enabled inference reported GPU device loss,
then renderer-heartbeat loss; no semantic pass was established or settings changed.
The read-only native follow-up found a failed inference trace and an unfinished
retry candidate, but no matching automatic capture or current renderer PID.
Broker heartbeat expiry is not an Electron unresponsive event. Root's healthy
Network payload sample and native Activity pagination-reset before-case were
retained separately and supplied to LZ-36 without changing its gates. See
`evidence/034-renderer-trace/review-incident-follow-up.md`; none of these facts
establishes a freeze cause or completes a native usability gate.

Root subsequently preserved a matched real freeze at `0f75340`, documented in
`evidence/renderer-freeze-20261101T1540/report.md`. Native Not responding and the
main hook identify window 1/PID 77897, request/job
`11a8cb1f-ce2c-45db-ae91-949094f3f1ff`, last stage `run`; this is the 2,087-token,
eight-question retry, not the previous request's MapAsync failure. Automatic
profiling timed out at enable. The exact-PID five-second OS sample records
9.2 GB footprint/11 GB peak and V8/JS/JIT/GC-related frames without bounded
application-function or `_OrtRun` attribution. Raw exported logs remain local.

After preserving evidence, Root used Desktop Relaunch only. Real tab interaction
recovered; all six features remain ON/Ready and idle unload Never. All three
LZ-28/LZ-36/LZ-37 session/attempt/workspace/model identities survived with new
activity. Recovery is not a fix. Native read-only investigations examined the
retry/recovery ownership path (`ses_e6832f0c0ffe7SDOnJPdQvMIDh`) and sampled stack
attribution (`ses_e6832f0b4ffehWZ5fxpIt8FVqd`). `sample-analysis.md` preserves the
unresolved application-function attribution. `recovery-findings.md` records three
separately reproduced source defects: known-loss rejection can leave a decision
session reusable before its loss callback, rejected disposal can become later
false success, and failed-load cleanup can escape ownership. Pending native work
cannot be treated as terminated merely because its caller timed out.

Plan `e2cfb569-7c01-4b6c-9bdc-a0e4ae10b89a` is admitted for compatible repairs:

- LZ-38 (`9a9ff061-b95a-409d-a43e-710dd04bfd30`) is running: preserve resident and
  failed-load cleanup uncertainty through the actual adapter, retryLoad, exclusive
  ownership and main lease. Repeated/concurrent disposal must not falsely permit
  replacement. Native release retry safety after partial failure is not assumed.
- LZ-39 (`99d6b8cf-1eea-4f6c-98ff-27afcd8a6240`) waits for LZ-38: retire only
  positively lost decision sessions through existing recovery, with no replay,
  duplicate recovery or generic-error false positives. Actual-adapter/runtime/
  broker tests cover callback ordering and pending-run cancellation/ownership.

Shared adapter/tests serialize through that dependency. Scopes avoid LZ-37's
runtime clock edits and LZ-28/LZ-36 source. Existing settings, engine/provider,
context limits, loss circuit breaker, worker identities and cancelled LZ-14
boundary are preserved. No broad rewrite or feature disablement is authorized.
Repeated native verification on the exact combined artifact remains mandatory:
three ordinary reviews near eight questions/~2,087 measured tokens with usable
native navigation, normal question/decision/speech/model switching, unchanged
all-six-ON/Ready apple-WebGPU idle-Never and preserved workers/history. Record
completion, correlation and footprint across repetitions. These are recovery
repairs, not a proven causal freeze fix.

LZ-37 returned `097eab95e592f4e6122c44aa525ef911c94bb9a7`; Root and independent
native review found no blocking source issue, and native review passed six focused
tests. Original focused/all/quality/build receipts passed unchanged. Its hold is
the artifact directory reference: committed verification.md is present, but
artifactExists accepts only files. LZ-40 (`44715414-30fd-41cc-bdd4-5fdc7591ad5e`),
plan `aee3ba37-ec68-4c4b-a2ad-b311a9643ff8`, is admitted to repair that generic
contract mismatch while retaining confinement, rejecting placeholder directories
and preserving all check/human gates. Do not rewrite LZ-37's immutable task,
redispatch its worker or repeat its diagnostic implementation. After reviewed
validator activation at a quiet inference boundary, reconcile existing matching
receipts normally. Runtime owns actual runner-scope serialization with LZ-28.
LZ-37 remains diagnostic clocks only, not the freeze fix.

LZ-28 returned `7e02ce0`; independent native review reproduced five blockers:
cancellation stuck behind archive recovery, invisible mutable results, concurrent
admission identity conflict, foreign-project recovery and stale checkpoint input
coverage. See `evidence/architect-context-lifecycle/retained-source-review.md`.
Do not activate this candidate. Correct it in the same retained attempt and carry
the user's `2536084` receipt selection fix into that source before final checks.
Original live renewal/archival/input/outcome proof remains pending. Root is
available for that proof and LZ-36's mounted UI proof once corrected, reviewed
candidates can be activated at a quiet inference boundary. Independent retained
workers must not be restarted.

Root's main `6f4d163` concise task-verification guidance and `74974e9` implementor
behavior-evidence guidance must survive integration. LZ-36 was instructed to drop
bundle-checksum-as-mount/evidence language: use the committed candidate and actual
mounted observations, not file-hash proof. This is an existing requirement, not
a new acceptance gate or authority to skip already-specified checks.

The initial canary reproducer was rerun in a disposable fixture and all three
private-content retention flags were true. That is a defect reproduction, not
evidence that a repair passed. All new UI/native gates require real observation.

## Phase 2 — personas, routes and measured value

After retained Phase 1 evidence, inspect the then-current implementation and
specify small dependency tasks for:

1. Whole-feature measurement through integration, including failures, repairs,
   Architect/review effort and interventions; unknown is not zero.
2. Dated OpenRouter average market fallback pricing with token-category semantics,
   separate actual charge/allowance and preserved historical basis.
3. Persistent task persona and live shared/project/task dispatch mappings with
   explicit precedence and immutable attempt-route history.
   Carry provider/model cache-policy information into Architect idle-renewal
   timing with explicit overrides; unknown retention is not a guaranteed TTL.
4. Model evidence database and Models panel: mapping editor, task-class tables,
   Pareto comparisons, sample/coverage and contributing trajectories; external
   evidence, observations and projections are distinct.

Do not pre-pin a model from a displayed recommendation or run paid synthetic
sampling. Use the approved model research as source pointers, not prompt bodies.

## Phase 3 — conversation-led evolution and useful research

Build immutable specification revisions and affected-dependency reconciliation
without stopping independent work, then expose current/history in Tasks. Keep a
direct specification editor out of this increment. Add focused native code/web
research delegation where useful, shared Models configuration through Architect,
and scoped reusable findings. Preserve earlier specifications and attempts;
scope amendments are not general intent revisions.

## Phase 4 — complete usable public-repository release

Prove installed-package operation outside this checkout, supported restart/upgrade
and backup/restore, retained work/settings, compatible host/dependencies and
shipped license/notices/version/setup/upgrade documentation. Continue real-task
cross-machine dogfood. Public repository release does not imply registry publish
or an announcement. Resolve any remaining license choice with the user before
setting it. Keep one plugin, native sessions/worktrees and no separate daemon.

## Continue from evidence

Review delivered diffs and discriminating checks, repair genuine findings and
integrate only accepted artifacts through runtime. Record native observations
against the exact artifact; never treat worker commentary, a build or a static
mock as that evidence. Preserve unrelated main-checkout changes. Source findings
are at `a69a4d6` and the existing as-of-refresh Repomix publication; re-inspect
when intervening changes affect a task.
