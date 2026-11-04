# LAZERS roadmap

LAZERS builds itself through OpenCode Desktop. The goal is accepted software
changes with clear intent, efficient execution and little manual intervention.

## 1. Tasks, Radar and Trajectory

Tasks needs explicit state filtering alongside Session/Project scope, including
completed, failed and cancelled work. Old tasks should open their own trajectories
with their recorded attempts. Keep the focused Linear-inspired list, grouping,
dependencies and compact task references.
Distinguish current work, attention and next eligible work using the runtime's
actual priority, dependency and reservation decisions.

Radar is the realtime system/agent monitor: each session's task, actual model and
effort, current tools, file read/edit activity, durations/results, trajectory health,
scheduler state and observed message/data flow. Lead with compact live activity;
keep architecture/state-machine maps as diagnostics. Tasks owns the work queue.
Show LAZERS-managed sessions by default, with optional other sessions inside the
selected scope. Keep selected details below the activity view, native theme/fonts
and stable focus. Use small live summaries/deltas with history fetched separately.
The [Astra review](reviews/astra-radar-perf-20261104.md) guides the next mockups.

Trajectory history should remain usable while live events arrive. Existing
lifecycle, trajectory privacy and renderer responsiveness defects remain open;
local inference stays enabled. Current findings are in the delivery audit.

### Proactive worker recovery

Add the reliability lane defined in [proactive worker recovery](proactive-worker-recovery.md)
alongside the existing panel and lifecycle work. Deterministic incremental rules
retain evidence of possible struggle and notify the current Architect without
interrupting the worker. Architect can let it cook, schedule durable follow-up,
or check in; investigate and steer the same worker; then reassess new evidence.
Continued struggle exposes a safe handoff/reconciliation decision, followed by
finishing scoped work or creating linked remaining tasks. Preserve identities,
dirty work, history, authorization and ordinary verification throughout.

Measure observation and intervention overhead, messages/wakes, attributable effort
and outcomes, including unsuccessful recovery and explicit unknowns. Distinguish
implemented behavior, fixture proof, native-observed branches and still-unproven
recovery; delivery or passing tests alone does not establish recovery. Reuse the
existing scheduler, notification and inspection paths, with optional progressively
loaded diagnosis/steering skills rather than another supervisor service or
mandatory prompt expansion. Serialize actual write conflicts without stranding
independent roadmap work or waiving its native gates.

### Implementer-owned live product verification

Deliver [live product verification](live-product-verification.md) alongside
recovery. Establish a usable full OpenCode Desktop instance containing the actual
candidate, with worker-qualified interaction tools, owned resources and a
discoverable project runbook. Existing-instance reuse may help, but does not replace
the full-instance launch requirement. Installed 2.2.5 has a test-root hook;
profile separation is source-supported, service isolation and worker operation
still require a controlled native trial. The user authorized that trial, including
recording and restoring protocol-handler state. Do not copy driver credentials.
Coordinate canonical GUI activation with the driving thread; no profiler arming.

Runtime must enforce automated checks → live probe → acceptance, with durable
probe runs separate from implementation attempts. Preserve historical contracts
as legacy, not retroactive passes. New contracts declare required scenarios or an
Architect-authored not-applicable reason. Bind evidence to the relevant candidate,
procedure, inputs and environment; retain existing human gates. Classify product
failure separately from environment, permission, resource and cleanup blockage.
Reprobe should preserve the worker where appropriate, not spend a repair merely
because setup was blocked.

Runtime must register owned resources before creation, retain bounded evidence,
and automatically perform idempotent teardown on success, failure and cancellation.
Reconcile interrupted setup/teardown after restart and retain actual cleanup
receipts, not model assertions. Keep uncertain/dirty resources unavailable until
positively reconciled; lease expiry is not quiescence. Unresolved cleanup does
not invalidate behavior evidence, block review/integration of valid code, or
trigger product reprobe or implementation repair. Do not report whole-delivery
cleanup complete until owned resources are reconciled. Combined candidates need
their own relevant probe evidence.

Package a concise progressively loaded product-verification skill and platform
references so native workers can actually discover and use them. Reuse existing
OpenCode/browser capabilities; web and React Native guidance must not imply
unobserved adapter support. Skills supply procedure, not acceptance authority.

Completion requires at least two real implementer probe executions, including a
product failure or honestly labelled environment blockage corrected and reprobed,
with final-candidate observations and confirmed cleanup. Count probe runs, not
replacement workers. Measure setup, waiting, interaction, repair, cleanup and
driver assistance with attributable usage and explicit unknowns. Source, fixture
tests, installed tooling and screenshots alone do not complete this lane.

### Delivery order for recovery and verification

These are increment boundaries, not claims of accepted work. Higher
priority dispatches first when dependencies and actual write reservations permit.
Use separate plans with integrated prerequisites where baselines must advance;
do not accumulate dependent work on stale runner source. Keep LZ-28, LZ-34,
LZ-36, LZ-39, LZ-46 and LZ-48 identities, candidates and pending gates intact.

| Slice                                               | Priority | Prerequisite                                    | Independently verifiable outcome                                                                                                                                                                                                                |
| --------------------------------------------------- | -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: modification journal                            | 25       | None; new recovery module only                  | Durable minimal insert/update facts, bounded consumption, atomic caller cursor/result transactions and explicit legacy coverage.                                                                                                                |
| V1: full-instance qualification                     | 25       | Controlled-trial authorization                  | Candidate-specific launch/acquisition tools and initial project runbook; an actual admitted worker proves tool access, isolated app/service identity, behavioral activation and owned teardown. Missing capability remains a concrete blockage. |
| R2: producer integration and deterministic concerns | 20       | R1 and reviewed LZ-28 baseline                  | Progress/journal mutations commit together; versioned repeated-failure rules survive reopening and exclude healthy work/provider or environment waits.                                                                                          |
| V2: probe definitions and receipts                  | 20       | Reviewed task-contract baseline                 | Versioned required/N/A definitions, assertion-linked candidate-bound receipts, producer provenance and unchanged historical parsing/idempotency. No launch or scheduling claim.                                                                 |
| V3: resource and fixture lifecycle                  | 20       | V2; V1 target-identity findings                 | Automatic idempotent owned registration/teardown, durable intents and receipts, restart reconciliation and exclusive resource identity. Unresolved cleanup blocks dirty reuse, not behavior review/integration.                                 |
| R3: notifications and dispositions                  | 20       | R2 and reviewed renewal ownership               | Evidence reaches the current Architect; cook, durable follow-up and check-in decisions are fenced, replay-safe and separate from execution state.                                                                                               |
| R4: check-in, steering and reassessment             | 20       | R3                                              | Same-worker guidance/response association, new-evidence reassessment and bounded escalation; admission, consumption and response stay distinct.                                                                                                 |
| V4: task probe scheduling                           | 20       | V2, V3 and reviewed LZ-28 idle/renewal behavior | Checks precede same-worker probes; current evidence gates acceptance; blocked setup spends no implementation repair and duplicate ticks cannot repeat uncertain setup.                                                                          |
| R5: safe handoff and linked remaining work          | 15       | R4                                              | Durable handoff, missing-response reconciliation and actual writer/background quiescence preserve partial work before another writer acquires scope.                                                                                            |
| R6: authorized recovery writer                      | 15       | R5                                              | Validated Architect command under existing user authorization creates a tracked recovery-writer record retaining original task/acceptance/history; exclusive ownership and ordinary artifact checks remain mandatory.                           |
| V5: combined probes and finalization                | 15       | V4                                              | Combined artifact invalidation, final-code checks after executable fixture removal, cancellation cleanup and separate product/teardown/worktree outcomes.                                                                                       |
| V6: probe/recovery projection and measurement       | 15       | V4, R2–R4 and reviewed Radar read baseline      | Classified probe facts feed the same recovery lane, existing inspection and attributable phase/assistance measurements without duplicate usage accounting.                                                                                      |
| K1: packaged progressive skills and runbook         | 15       | V1, stable V4 tools and R4                      | Native discovery/loading of product-verification and focused diagnosis/steering guidance; usable platform references, no mandatory prompt expansion.                                                                                            |
| N1: native walkthrough and closure                  | 10       | Integrated R4–R6, V5–V6 and K1                  | Two real implementer executions with correction/reprobe, native recovery/reassessment evidence, final integrated smoke, reviewed checks and confirmed owned cleanup. Unobserved branches remain explicit.                                       |

The executable front of this sequence is R1 **LZ-49** (plan
`59987993-9ec5-4f75-99cc-2a68f08e2b58`), V1 **LZ-50** (plan
`b76de1a5-4c2b-423e-8867-0afa7e704c07`) and module-only V2 **LZ-51** (plan
`1cf7467a-398f-4936-b5db-b541e749f39e`). All use isolated workspaces. V2 exposes
no new authoring contract until V4 can enforce it; it does not retrofit active
tasks. Remaining rows require their own reviewed specifications and admitted plans.

LZ-52 (`907c6403-6f46-465b-83c7-79cf39e92b35`) supplements R1 before producer
activation: exact stored-page correspondence and late-project coverage must not
skip captured facts. LZ-53 (`f4b36a89-917f-4eb4-94a4-8f05b7649766`) corrects the
observed targeted-index permission fan-out, preserving real authorization; focused
totals count authorized selected matches. Neither replaces an existing worker.

R1 source (LZ-49/52 plus Root's prefix/sparse-page corrections) is integrated in
`e18b826`; V2 source (LZ-51 plus Root's cleanup-separation correction) is also
integrated. Their module-only plans completed normal owned-worktree cleanup.
These landings do not establish native producer activation, full-instance
qualification or V3's automatic resource lifecycle; LZ-50's original trial and
all later recovery/verification lanes remain applicable.

Combined-probe ownership must be an explicit authorized continuation/assignment,
not another implementation attempt fabricated for counting. Establish its narrow
receipt authority before V5 dispatch. Environment generations change on relevant
candidate/procedure/configuration/target or ownership changes; uncertain external
effects require positive identity/readback reconciliation, not timeout-based reuse.
Worker-reported results remain provenance-bearing claims until required tool
observations and any explicit Architect judgment are satisfied.
Procedure/input/environment freshness uses runtime-owned durable revision,
generation or record identities—not implementer hashing or invented evidence
digests. Internal canonical idempotency fingerprints and Git candidate identity
remain valid. Receipt invalidation must be mechanical and testable.

#### Source-attached recovery handoffs

Fold the [handoff and clarification contract](recovery-handoff-contract.md) into
R3–R6 and the existing live walkthroughs. Running LZ-49/50/51 contracts remain
unchanged; new work is additive and linked. Submission is never completion,
acceptance, proof of stopping, or authority to alter the source task.

| Slice                                        | Prerequisite                                           | Outcome                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1: shared review policy                     | Reviewed task-hardening source                         | Reuse one three-total-round engine for tasks and handoffs, with subject-specific fixed checks, focused correction, non-regression, replay/interruption and retained concerns. Preserve existing task behavior and records.                                      |
| H2: durable handoff domain                   | Current SQLite/task ownership interfaces               | Source-request/task/attempt-bound drafts, immutable versions, review reservations/history, concerns, final reports and append-only Architect dispositions; bounded reads survive session/workspace removal.                                                     |
| H3: assigned-worker tools and requests       | H1, H2 and delivered R3/R4 request/delivery interfaces | Runtime records and sends identified requests; `lz-verify-handoff` reviews structured input, and `lz-submit-handoff` atomically attaches the exact report/history and queues notification. Permission/ownership/structure precede inference.                    |
| H4: stopped-worker report-only collection    | H3                                                     | Narrow request-bound tools/reads in the retained session, without shell/edit/Code Mode escape or resumed implementation authority. Missing response and unknown quiescence remain explicit.                                                                     |
| H5: Architect correction and actual delivery | H3 and delivered R4/R5 continuation/handoff interfaces | Evidence-backed disposition and material human decisions persist separately from task retirement; current correction reaches continuing/replacement workers through actual readable instructions/context, including concrete automatic-repair failure receipts. |

H1/H2 can proceed independently of runner integration. H3–H5 serialize with real
runner reservations and depend on implemented interfaces, not roadmap labels.
Bind reviews to the relevant effective source contract, exact draft/evidence and
check definitions without invalidating on unrelated plan-version increments.
Preserve original intent/decision references when available; mark missing original
request text unknown rather than reconstructing it from the task objective.

The existing walkthroughs must demonstrate request → enabled hardening → DB
attachment → Architect disposition → actual downstream correction retrieval →
subsequent checked/probed behavior. Disabled/unavailable review remains honest and
recoverable, but cannot substitute for a working enabled path. Correct the
location-plugin forwarding/discovery blocker through supported connection APIs;
do not rotate/copy credentials or restart the healthy driver to mask it. Retain
the observed 9,930 ms Tasks query and 5,000 ms poll failure path without attributing
RPC latency or device/ownership failure prematurely. No profiler arming, arbitrary
timeout increase, or weaker ownership checks is authorized.

#### Verification reservations and safe writer release

Observed LZ-28/LZ-36 friction is a design input, not authorization to bypass
reservations. Current admission conservatively treats preparing/running/verifying
attempts as full-scope occupants. A missing human gate therefore retains broad
code scope even when no implementation turn is active. Git commits are immutable,
but their checkouts, ignored build outputs and external processes are not;
session idle or interruption acknowledgement alone cannot prove writer quiescence.

V3 first distinguishes actual external UI/service/profile/fixture resources with
durable conflict identities and ownership generations, without relaxing existing
code admission. Aliases and different projects must not acquire the same actual
resource independently. Separate uncoordinated databases/services cannot claim
global exclusivity; expose unsupported coordination as blockage.

V4 should add an opt-in isolated write-ownership → candidate-verification →
write-reacquisition protocol only for a qualified boundary. Before releasing broad
implementation scope, preserve the exact scoped candidate, reconcile pending
write-capable effects/background work, establish safe isolation or quiescence,
and prevent subsequent source writes without reacquisition. Retain ownership of
the candidate execution workspace and mutable product/fixtures. Unknown/legacy
attempts and shared checkouts keep conservative protection; isolated worktrees
alone do not establish release safety. If the host cannot establish the required
boundary, report that limitation rather than promising reduced contention.

Repairs and executable fixture changes must reacquire code/checkout ownership
before an edit-capable turn, through the same conflict predicate used for fresh
dispatch, resume and scope amendment. Preserve the same worker and request/run
generation, invalidate affected checks/probes, and never spend an implementation
repair on environment waits. Test competing isolated writers, busy/background or
uncertain owners, blocked repair reacquisition, shared-checkout serialization,
cross-project resource aliases, crash/replay and cancellation cleanup. Existing
candidate-bound receipt selection remains required. CANCEL/RESUME is not the new
verification-phase protocol.

## 2. Personas, models and measurement

Each task carries a persona/agent. Start with UI, Systems and Small task/refactoring
implementors. The persona stays with the task; model/effort is resolved at dispatch
from a live hierarchy of shared defaults and project/task overrides. Running
attempts retain their chosen route and history. Future selection rules can use
observed performance, prices, promotions and other user criteria.
Architect idle-renewal timing should account for provider/model cache policy
and explicit overrides; unknown retention stays explicit rather than inferred
from a cache price or promised as a cache hit.

A Models panel edits these mappings and shows a model database combining native
OpenCode/Go metadata, OpenRouter prices/benchmarks and our observed results. Show
tables and Pareto comparisons by task class/persona, including tokens, cost,
acceptance, rework, elapsed time and sample size. Distinguish external evidence,
observations and projections, and link results to contributing trajectories.

Scheduler and Trajectory own measurement through integration, including failed
attempts, repairs and attributable Architect/review effort. OpenRouter average
market pricing is always the fallback index for subscription model/effort usage.
Keep dated price/averaging basis and actual charges/allowances separate.

## 3. Plan evolution and research

Users revise task goals and acceptance through Architect conversation. Preserve
previous specifications and attempts; reconcile affected dependencies and active
work while independent work continues. Tasks shows the current specification and
history; a direct specification editor is later work.

Architect should be able to delegate focused code investigation and current-web
research using native agents and reusable repository context. Guided model
configuration uses the same mappings as Models. Useful source findings and
pitfalls should carry into relevant later work without growing agent prompts.

## 4. Complete usable release

A complete usable release belongs in the public repository. Continue dogfooding
on other machines and real tasks; no announcement is planned.

The installed package must work without this development checkout, preserve work
and settings across supported restarts/upgrades, and have a supported backup and
restore path. Finish versioning, license/notices, host compatibility and setup/
upgrade documentation. Keep the one-plugin distribution without a separate LAZERS
daemon or inference server.

## References

- Research and decisions: `.agents/docs/phase-review-plan.md`
- Proactive recovery behavior and acceptance: `design/proactive-worker-recovery.md`
- Live product verification behavior and acceptance: `design/live-product-verification.md`
- Recovery handoff and clarification: `design/recovery-handoff-contract.md`
- Current delivery/defects: `.agents/docs/production-audit-and-next-phases.md`
  and `.agents/docs/evidence/architect-context-lifecycle/review.md`
- Radar prior art: https://github.com/thejustinwalsh/gh-wat-dis
- Model/persona research: `.agents/docs/implementor-profiles.md`
  and `.agents/docs/research/phase-planning/models.md`
