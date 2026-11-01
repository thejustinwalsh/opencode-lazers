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
exact artifact. Original attempt is accepted; normal combined reconciliation
is running. No duplicate activation was performed. Record integration/cleanup
only after runtime combined acceptance.

Stable live Trajectory is now LZ-36 (`68a72431-87af-4bce-8e7b-77f430aeb100`),
plan `1fab1396-5f6b-45cc-a148-5eff48182ed9`. Execution is admitted but waits for
LZ-32 integration, then serializes true observation-file conflicts with Radar.
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

- Stable live Trajectory: specify after inspecting retained LZ-31/LZ-32 output;
  preserve old expanded pages/selections while new events arrive. Use durable
  sequences/stable history boundaries and separate current status from history.
  Measure native-context calls/read cost before and after; unchanged status
  refresh must not rematerialize full context. Serialize overlapping observation
  and panel-state writes with Radar. Do not restore the privacy defect.
- Existing failed LZ-14 renderer responsiveness: retain its task/attempt history,
  inspect captured stages and establish the actual blocking boundary before
  repair. Keep local inference enabled. Ownership was reassigned for investigation,
  but execution was not resumed. The explicit human cancellation in the retained
  `019-desktop-inference-isolation/triage.md` prohibits restoring/refining that
  abandoned refactor/stash. The newer roadmap authorizes the responsiveness goal,
  not an unproven root-cause claim or automatic resurrection of that implementation.
  No new debugger capture exists in the documented diagnostics directory at this
  checkpoint. Establish causal evidence and a compatible bounded repair before
  requesting execution; do not conflate absence of a new capture with resolution.

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
