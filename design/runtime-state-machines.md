# Runner state machines and recovery

`src/runner/lifecycle-machines.ts:lifecycleMachines` is the shared XState registry.
It contains the existing task, dispatch-control and Architect-source machines and
the persisted runner lifecycle machines below. State values remain compatible
with existing records. No task snapshots or attempt history are replaced.

| Domain                | XState definition             | Persisted update path                                   | Recovery / completion                                                                                                                                                                                      |
| --------------------- | ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task                  | `taskMachine`                 | `RunnerStore.move()`                                    | Reconcile, resume, retry, retained repair/acceptance, cancellation or incorporation                                                                                                                        |
| Plan                  | `planMachine`                 | `lz_runner_transition('plan', state, event)`            | Submit admits; Architect commands (proceed, retry, reconcile, cancel); cleanup probes; integration or cancellation                                                                                         |
| Attempt               | `attemptMachine`              | `lz_runner_transition('attempt', state, event)`         | Resume/retry; cancellation preserves the previous attempt and checkout                                                                                                                                     |
| Effect                | `effectMachine`               | `lz_runner_transition('effect', state, event)`          | Reconcile a native receipt, or record conclusive failure; never replay an unknown prompt, session or worktree effect. A verification effect with no receipt is superseded (`failed`) and its check re-runs |
| Dispatch              | `dispatchControlMachine`      | `RunnerStore.setDispatchPause()`                        | Explicit unpause or recorded integration conditions                                                                                                                                                        |
| Architect source      | `architectSourceMachine`      | `architectSourceTransition()`                           | Prepare, activate or retire                                                                                                                                                                                |
| Architect renewal     | `renewalMachine`              | `lz_runner_transition('renewal', state, event)`         | Continue creation/archive, recover input, roll back or defer; retry deferred creation                                                                                                                      |
| Outcome delivery      | `outboxMachine`               | `lz_runner_transition('outbox', state, event)`          | Pending until in the Architect inbox, then delivered or superseded; one coalesced notice per session replaces queued ones via inbox cancel                                                                 |
| Descendant adoption   | `adoptionMachine`             | `lz_runner_transition('adoption', state, event)`        | Revalidate checks, accept or cancel a held operation                                                                                                                                                       |
| Retained verification | `retainedVerificationMachine` | `lz_runner_transition('retained', state, event)`        | Run the task checks on the given commit, then pass or fail; a plan cancellation cancels a live call. A failed call is re-run by a new `verify-retained`                                                    |
| Verification resource | `verificationResourceMachine` | `lz_runner_transition('resource', state, event)`        | Confirm native creation/removal; re-observe uncertain resources                                                                                                                                            |
| Verification check    | `verificationCheckMachine`    | `lz_runner_transition('check', state, event)`           | Resolve intended/uncertain execution from its bound receipt                                                                                                                                                |
| Check cleanup         | `verificationCleanupMachine`  | `lz_runner_transition('cleanup', cleanup_state, event)` | Retry failed cleanup; record confirmed completion separately from check success                                                                                                                            |

`lifecycleTransition()` resolves the persisted row state through XState and uses
`current.can()` and XState's pure `transition()` before returning the next state.
The SQLite bridge evaluates against the row being updated inside the existing
transaction. Existing owner/version/attempt/resource predicates remain in their
handlers. `registerLifecycleTransitions()` installs the bridge once per connection;
`RunnerStore.atomic()` reinstalls it after a closed connection reopens.
`validateRetainedLifecycles()` also validates workspace and operation-cleanup
fields before saving the retained operation payload. Retained
verification's standalone store also registers it through its schema entry point.

Acceptance is verification checks plus the Architect's review and integrate
decision. There is no human-evidence gate: no `human-evidence` command, no
`waiting-human` adoption or retained state, and `kind: "human"` evidence in a
stored task is read and dropped.

Initial inserts use each machine's declared initial state. Native observations
such as `ArchitectSourceResult.state` describe OpenCode results; they are not
runner transition authority. `verificationCheckMachine` permits a previously
completed command to become uncertain when subprocess settlement changes;
command results and cleanup are retained separately. There is no
`retry-authorized` check state: a check is re-run by a new retained verification.

## Deleted-worker cancellation defect

Previously, both missing-session branches in `TaskRuntime.cancelWorkers()` set
`waiting = true` indefinitely. Native `RunnerHost.session()` null means an
authoritative missing session; transport errors throw instead. The plan remained
`cancelling` and could not reach its normal retry flow.

`TaskRuntime.cancelMissingWorker()` now rechecks the exact latest attempt and
current plan ownership/state, refuses unsettled attempt effects, and uses the
existing cancellation transition. `WORKER_SESSION_ABSENT` records the observation
with Unix milliseconds. It does not fabricate a worker success, interrupt another
session or delete the checkout. Native cleanup still checks dirty/unmerged work.
The owner can explicitly retry the cancelled task; the new attempt keeps the old
attempt and retained files available for review. Legacy `unknown` attempts are
explicit states and only the latest such attempt participates in cancellation.

## Verification

`lifecycle-machines.test.ts` traverses the declared XState graphs and rejects
unintended sink states. It also rejects illegal completion shortcuts. Runtime
regressions cover disappearance at initial and detailed reads and legacy unknown
attempts, followed by cancellation and retry with partial work preserved.
`store.test.ts` exercises a reopened connection and an illegal persisted update.
Graph reachability is distinct from satisfying native-resource or user-decision
prerequisites; recorded unknowns are not converted into successful execution.

## Live idle check replaces the idle report

No state waits for an `experimental.idle` report. A worker is idle when the host
reports it now: session not busy, no pending input, permission or form, no
running shell whose cwd is inside the worktree, and no active child session.
`RunnerHost.session()` supplies `busy`, `pendingInput`, `pendingPermissions`,
`pendingForms`, `runningShells` and `activeChildren` from the same reads every
tick; `TaskRuntime.backgroundBlockReason()` turns a positive shell or child
count into a visible `WORKER_BACKGROUND_WAIT` hold. `unknown` no longer exists:
an unreadable host throws and the next tick asks again.

Deleted with it: the `runner_native_idle` write path and its report, terminal,
pending-terminal, invalidation, stale-sequence and execution-start lineage; the
`WORKER_BACKGROUND_UNKNOWN` hold; the prior-continuation-background exception;
retained-repair idle lineage binding; and the `NativeCleanupSettlement` host
call. The plan, attempt and effect machines needed no new states: every hold the
idle report created exits on an observable event (the shell or child ends, the
session stops being busy) or on the existing `reconcile`, `retry` and `cancel`
controls. Existing holds whose reason names the retired report
("Native idle background observation ...") clear through the same
`resumeTransientObservationWait` path on the next observation.

## Cleanup removes a worktree without owner authorization

`cleaning`, `cleanup-blocked` and the `worktree-remove` effect keep their
transitions. `CleanupRecoveryAuthorization`, `WORKTREE_CLEANUP_RECOVERY_AUTHORIZED`,
`WORKTREE_CLEANUP_SETTLEMENT_OBSERVED`, the owner-epoch binding on them and the
`recover-cleanup` command are deleted. The effect moves to `completed` when the
change is contained in the checkout, the tree is clean and the worker is idle by
the live check above. A failed precondition keeps the effect `held` (or
`uncertain` after a native attempt) with its reason on the plan; the scheduler
re-evaluates it when an observed fact changes (`worktreeCleanupFactsChanged`),
every 5 seconds while the blocker is live activity, and every 60 seconds
otherwise. An unchanged blocker records neither a new `CLEANUP_BLOCKED`
transition nor new receipt history. `cleanup-blocked` exits through
`cleaning` (the blocker cleared or `integrated` was re-recorded), `integrated`,
`blocked`, `running` or `cancelling`.

## Cleanup preconditions do not block retry

A fresh `worktree-remove` effect that fails a precondition before native cleanup
is sent moves to `held`, with `notSent: true`. A later probe records `intended`
before sending native removal or retiring the loaded location. Unknown results
from attempted native cleanup remain `uncertain`; legacy ambiguous receipts are
not treated as proof of no send. The existing pending-effect checks do not treat
`held` as an in-flight effect. Dirty files remain intact while the owner retries
in a different attempt checkout. All three deleted-worker regressions now drive
a cleanup tick before retry and assert this distinction.

## Validation record

- Frozen runner suite: 749 tests, 9,584 assertions, zero failures.
- Final retained lifecycle validation: 92 tests, 1,059 assertions, zero failures,
  including the operation's serialized cleanup state.
- Final cleanup/retry regression selection: 20 tests, 418 assertions, zero failures,
  after adding the explicit `held` effect state.
- Storage: 19 tests, 148 assertions, zero failures.
- Read-only native vocabulary audit: 10,760 state-field entries across 17
  groups, zero unrecognized state values.
- `bun run verify` and `git diff --check` passed.

## Scheduler progress across plans

`TaskRuntime.runTick()` retries eligible plans after a failed native observation.
`reconcilePlan()` isolates plan stepping, terminal cleanup, and outcome delivery
by plan. It records changed failures as `PLAN_STEP_FAILED`,
`PLAN_CLEANUP_FAILED`, or `PLAN_DELIVERY_FAILED` under the current scheduler
fence. Error text is redacted before the transition record is written. These
records do not change the workflow state or clear a pending side effect. Lease
claim and stale fence failures still propagate.

An Architect renewal with a recorded failure in its current phase stays
eligible for recovery without aborting dispatch for other plans. The regression
for a failed worker lookup checks that a second plan starts, that repeated
identical failures produce one record, and that a later authoritative absence
settles the original cancellation.

Validation: `runtime.test.ts` and `lifecycle-machines.test.ts`: 352 tests,
5,787 assertions, zero failures. `bun run verify` passed.

## Recovery from observed dispatch stalls

- A retained verification no longer holds, so nothing needs to settle a held one
  when a worker continues: the call fails when its plan, task or attempt changed.
- `failMissingWorker()` settles an authoritatively absent worker as failed
  under the scheduler fence. It rechecks the current assignment and unsettled
  effects before releasing the reservation. Native lookup errors do not take
  this path; worktree contents remain available.
- `RunnerStore.dispatchReservations()` supplies both dispatch and Tasks'
  conflict display. `TaskReads.effectiveExecution()` displays write-scope and
  prerequisite waits while retaining the recorded task lifecycle.

On 2026-11-11, LZ-154's held operation
`c9716b2c-f69c-4664-8143-7cb14c60ff9f` was cancelled by the scheduler at
08:08:47 America/Detroit. A new prompt effect completed at 08:08:48 for the
same worker. The native Tasks RPC subsequently reported LZ-154 running,
LZ-203 waiting on LZ-154's write scope, and LZ-88 waiting on blocked prerequisite
LZ-72. The native active-session inventory included the LZ-154 worker.

On November 11, the LZ-203 Architect received
`Permission.DeclinedError` at 10:37:26 EST while OpenCode was reloading
loaded locations. Reload finished at 10:37:39 EST. The activation helper had
checked for open requests and in-flight tools but admitted an active session
between tool calls. For a live service-wide reload, wait for the native active
session inventory to clear. OpenCode can decline a call as its location
permission service closes. Retry the unchanged command after reload completes
if the plan state still allows it.

## Simplified orchestration: the request is the authorization

These rules are enforced by deleting states and gates, not by adding bypasses.
`lifecycleMachines` remains the only transition authority.

### No dead ends

`lifecycle-dead-ends.test.ts` enumerates every machine in `lifecycleMachines`.
Each transition event is classified as a directly observable event or an
Architect action (proceed, retry, reconcile, cancel). Every non-terminal state
must have a non-self exit of one of those kinds, and a state declared terminal
must really have none. A new state or event fails the test until it is
classified, so a stall-capable state cannot be added silently.

### Holds advertise their unblocking actions

`hold-actions.ts` maps each hold-reason family to the actions that unblock it.
`TaskRuntime.hold()` advertises the caller's actions merged with that family's
actions; read-only `audit` never counts. A reason that matches no family still
advertises `reconcile` and `cancel`. `hold-actions.test.ts` checks every family
and that every literal reason in the runtime maps to a named family.

### Submit is admit

`lz-submit-plan` admits the plan and the scheduler runs its tasks; no Architect
`run` is needed. Base-commit and model-route preflight remain in admission. A
plan is saved as a draft only when the Architect passes `draft: true`; `run`
admits an explicit draft. Drafts created before this rule are admitted on the
next scheduler tick.

### Verification effects are re-runnable

`verify:`, `graph-verify:` and `mechanical-fix` effects only read the candidate.
When reconciliation finds no receipt, the effect moves to `failed` with
`superseded: true` (`EFFECT_SUPERSEDED`) and the same check runs again on the
current candidate under a new effect ID. `reconcile` no longer refuses while only
these effects are uncertain. Prompt, session and worktree effects keep the
journal: they are never replayed without a receipt.

### The owner is advisory; routing is cost-aware

Any live Architect session of the project may command a plan. The runtime
adopts it as owner (`OWNER_ADOPTED`, no version change). `planControlEpoch` and
every authorization bound to it are deleted; legacy rows that carry an
`ownerEpoch` still parse and it binds nothing.

When work needs judgement (a hold, outcome, question or review) the scheduler
routes it with `routeArchitect()`:

| Owner state                                                | Decision                 | Reason          |
| ---------------------------------------------------------- | ------------------------ | --------------- |
| Live, last model activity within `architectCacheWindowMs`  | reuse (queue when busy)  | `warm`          |
| Live, cold, context below `architectReuseMaxContextTokens` | reuse (queue when busy)  | `small-context` |
| Live, cold, context at or above the limit (or unknown)     | fresh Architect, adopted | `cold-large`    |
| Missing, archived, or not an Architect                     | fresh Architect, adopted | `missing`       |

Defaults: `architectCacheWindowMs = 5 minutes`, the common floor of advertised
prompt-cache lifetimes (Anthropic's default TTL is five minutes and refreshes on
a hit; OpenAI documents cached prefixes surviving roughly five to ten minutes;
OpenRouter passes the provider's caching through). `architectReuseMaxContextTokens
= 32,000`. Context size comes from session usage; unknown counts as large. The
decision is recorded once per change as `ARCHITECT_ROUTED` with its reason. The
fresh session is created by the existing renewal machine (`renewalMachine`), so
the checkpoint from `lz-record-architect-continuity` seeds it; the old session is
left alone. `ensureArchitectOwner` runs before any early return in a plan step,
so routing always reaches a live Architect. `architectIdleWindowMs` remains only
as a deprecated alias of `architectCacheWindowMs`.

### A cancelled prerequisite drops its edge

`reconcileCancelledDependencies` removes the edge to a cancelled prerequisite
plan (`afterPlans`, `resumeAfterPlans`) or task (`dependencies`) through a plan
revision recorded as `DEPENDENCY_EDGE_DROPPED`, and notifies the Architect with
status `dependency-dropped`. Dependents continue; they are not held. A hold left
by an earlier version is released through the existing task and plan machines.

## Source quarantine is deleted

The source-quarantine ceremony is gone: the `quarantine-source` command, the
`runner_source_quarantines` table and its pending/sealed phases, the
`quarantine` lifecycle machine, the source-guard registry, the `lz.source-fence`
RPC, `host.ensureSourceGuard` and `host.archiveRetainedWorker`, and the worker
tool guard that denied quarantined sessions. Each `ensureSourceGuard` call
against an unloaded worktree booted a full OpenCode location; 55 of them (13
sealed rows re-guarded every pass) froze the service.

A stopped worker's checkout now simply stays reserved until it is cleaned up,
which removal handles after the live idle check. `verify-retained` needs a
blocked, accepted or cleanup-blocked plan. Runner schema generation 9 drops the
table and moves any plan blocked on a quarantine through the plan machine
(`retireSourceQuarantines`, `PLAN_GATE_RETIRED`). Legacy retained operations
that carry a `sourceQuarantine` field still parse; it binds nothing.

Observation never boots a location. `workerObservation` reads location-scoped
inventories only when the location is already loaded, and the trajectory host
checks a recorded attempt workspace by path (`ownsRecordedWorkspace`), not by
asking the host to open the worktree.

## Scope review at verify

Scope is a model, not a path list: `writeScope` (edit), `createScope` (expected
structure) and `protectedScope`. `classifyChange` (`src/runner/scope.ts`) labels
each changed path `in-scope`, `expected-new`, `allowed-new` (a new file in a
folder that holds an edit- or create-scoped file, or a test/fixture beside or
mirroring one), `divergence` or `protected`. No new state exists.

- `protected` stops the candidate before the checks (`SCOPE_DECISION_REQUIRED`
  kind `protected`, `ArtifactScopeViolation`); `amend-scope` naming the exact path
  releases it.
- `divergence` does not block. The checks and the Fallow audit run, then
  `decideVerification` folds the divergence into the one repair (with failures
  and findings). With no repair left it is `SCOPE_DECISION_REQUIRED` kind
  `divergence`, a `blocked` hold (family `scope-divergence`) that advertises
  `amend-scope`, `retained-repair`, `reconcile` and `cancel`, so it appears in the
  recovery bundle. `amend-scope` plus `reconcile` re-verifies and accepts.
- `SCOPE_REPORTED` records the report (created, missing expected, divergences,
  accepted, size warnings); `task-accepted` carries it for the Architect.
- Reservations (`effectiveReservationScope`) are edit plus create paths; the
  derived allowance never reserves. A divergence into another task's scope is
  listed with that task in the report.

## Hold audit

Holds raise only for real, directly observable loss, with an advertised unblock.

- A write-scope overlap during mechanical preparation is a warning
  (`SCOPE_OVERLAP_WARNING`, recorded once); it never holds.
- An interrupted worker resumes by itself: the runtime issues the exact-attempt
  `resume` once per input (`WORKER_AUTO_RESUMED`, at most three per attempt). The
  hold stays only as the fallback and advertises `resume`.
- A worker that went idle without a completed response to its input fails the
  attempt (retried through the normal path). A completed turn for a different
  input stays a hold that advertises `reconcile`, so the Architect can bind it
  as a review input.
- Runner schema generation 11 runs `retireStaleHolds`: plans blocked on a hold
  the simplified code no longer raises (`experimental.idle` background
  observation, `Recovery uncertain for verify:/graph-verify:`, the old
  interrupted-worker text, the scope-reservation hold) move through the plan
  machine, and verification effects that never produced a receipt are
  superseded so the check re-runs. A retired cleanup hold resumes `cleaning`.

## Retained verification is one call; continuation fingerprints are deleted

`verify-retained` verifies one commit in a temporary worktree with the task's
declared checks and records pass or fail. Its operation machine is
`pending -> task-checks -> accepted | failed | cancelled`; a plan cancellation
cancels a live call and nothing else resumes it. A failure notifies the Architect
(`retained-verification-failed`) and the Architect runs `verify-retained` again.
On a pass the task accepts the commit (`RETAINED_ACCEPT`), a plan stopped on that
task's failure runs again, and the ordinary combined check accepts the plan; the
call never accepts the plan itself.

Deleted: retained generations and their paged inspection view, check retry
authorizations (`retry-authorized`), the `held`, `task-accepted` and
`combined-checks` states and the combined phase, the `extend-verification-deadline`,
`continue-retained-check` and `cancel-retained-verification` commands with their
schema fields, the plan-version binding on an operation (a stranded operation read
"retained operation binds plan version 43, while the plan is now version 59"),
`settleSupersededRetainedVerification`, and the combined-check continuation binding
and its fingerprint. `resume` without a task re-runs the combined check on the
current candidate: a blocked, unaccepted plan runs again, and its combined check
effects without a conclusive receipt are superseded. Stable change identity (tree
OID, patch-id, `refs/notes/lazers`, containment proofs) is untouched.

Runner schema generation 12 runs `retireRetainedVerificationGates`: an open
operation closes as `accepted` when a task-acceptance event names it, otherwise
`cancelled`, and its checkouts clean up through the terminal reconciler;
payloads lose the generation, plan-version, authorization, quarantine and
fingerprint bindings; the generation column leaves the operation, evidence and
resource tables; `retry-authorized` checks become `completed`; a plan blocked on
a retired binding moves through the plan machine; queued held-verification
notices are superseded. Older operations that carry a combined checkout still
parse that field so terminal cleanup can remove it; nothing creates one. Amendments
recorded by earlier deadline extensions still resolve for the exact checks they
named; nothing records a new one.

## Commands are decided by the recorded state, not a caller version

No model-facing tool takes `expectedVersion` or `expectedRevision`; a model has no way to learn
a counter except by calling `lz-inspect-plan` first. `src/runner/plan-commands.ts` maps each
plan command to the plan-machine event it drives and the states it may start from; legality asks
`lifecycleMachines.plan`. A refused command names the state and what applies, for example
`Plan is integrated; retry is not available. Available: none.` The check runs before any
asynchronous effect and again inside the command transaction.

The runtime still compares against the plan version it read itself when it began handling
the command (`PlanMovedDuringCommand`). If a tick moved the plan between its native or Git
observation and its transaction, the command is re-read and re-evaluated, at most three times,
then fails naming the current state. Idempotency stays on `requestID`; a receipt recorded with a
legacy `expectedVersion` still matches a replay without it. A stray `expectedVersion` or
`expectedRevision` from an older prompt is dropped before validation (plan command, recovery
tools, `lz-configure-models`). The Desktop route editor keeps its own `expectedRevision` guard,
because two open panels can edit one route.

## Accepted plans can be cancelled

`accepted` already reaches `cancelling` in `lifecycleMachines.plan`; two gates hid it.
`PLAN_COMMANDS.cancel.from` now lists `accepted`, and `commandCancel` no longer carries its
own `terminalPlanStates` guard, because `planCommandProblem` is the single legality check.
`integrated` and `cleanup-blocked` stay uncancellable: integration is already recorded.
Cancelling an accepted plan (`lz-plan-command` `{action:"cancel", planID, reason}` from its
Architect) settles in `cancelled`, releases dispatch reservations, and the terminal cleanup
tick removes owned worktrees non-forced; a worktree holding unmerged commits is preserved
as a `held` `worktree-remove` effect.

## A retry can leave the shared checkout

`PlanInput.workspaceMode` is fixed once an attempt exists (`changeSchedule` refuses it), and a
shared task is scheduled in the project checkout behind every active dispatch reservation.
`retry` with `workspaceMode: "isolated"` now revises the plan body the same way
`selectSharedWorkspace` does for `shared` (a `runner_plan_revisions` row and a
`WORKSPACE_SELECTED` event with `mode: "isolated"`), so the new attempt gets a native
`.worktrees` workspace. The earlier attempt's workspace and receipts are untouched.

## Stale attempts stop holding reservations

A dispatch reservation is derived from `activeProjectAttempts()` (attempts in `preparing`,
`running` or `verifying`), so an attempt nobody settles reserves its checkout and write scope
for good. The reconcile tick (`settleStaleAttempts`) gives such attempts a machine-decided
exit that needs no Architect contact:

| Condition (latest attempt of its task, no `intended`/`uncertain` effect)                      | Attempt becomes                        |
| --------------------------------------------------------------------------------------------- | -------------------------------------- |
| Node already `accepted`/`incorporated` (retained acceptance that predates attempt settlement) | `accepted`, node artifact adopted      |
| Plan `blocked`; session absent, or archived and quiet                                         | `failed` (retry/resume stay available) |
| Plan `cancelled`/`failed`/`exhausted`; session absent, or archived and quiet                  | `cancelled`                            |

A live session (not archived, busy, pending input/permissions/forms, running shells or active
children) is never settled: it is a retained worker the Architect may resume. Each settlement
records `ATTEMPT_STALE_SETTLED` with the cause. The two live `verifying` attempts on `running`
plans were the first case: retained verification had moved the node to `accepted` (event
`RETAINED_ACCEPT`) through a code path that did not also move the attempt.

## Recovery bundle

A failed task or a held plan waits for its Architect to choose an unblocking action.
When Architect contact was paused, or a notice went unanswered, that work sat for
weeks. The scheduler now hands every stale item to an Architect as one bundle.
No state or transition is added: an item is a reading of existing plan, node and
attempt states, and a bundle is an outbox row plus a journal event.

`src/runner/recovery-bundle.ts` collects an item when all hold:

| Rule      | Definition                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind      | plan `blocked` or `failed` (held-plan); node `failed`, `exhausted`, or `blocked` with a failed latest attempt in an open plan (failed-task); plan `accepted` (accepted-unintegrated); `cleanup-blocked`; `cancelling` (stuck-cancelling)     |
| Stale     | no meaningful transition on the plan for `RECOVERY_STALE_MS` (2h). Observation events (`OUTCOME_`, `ARCHITECT_`, `CLEANUP_`, `EFFECT_`, `SOURCE_`, `WORKER_`, `OWNER_`, ...) do not count; an Architect command does, so acted-on work waits |
| Not live  | no attempt of the item has a session that is busy or has pending input, permission or form; a `native-input` hold is excluded                                                                                                                |
| Not ended | `cancelled`, `integrated` and disposed tasks never appear                                                                                                                                                                                    |

Each item carries its `LZ-n` reference, panel state word and explanation
(`taskStateView`, `taskExplanation`, `taskReasonView`), hold family, the
unblocking actions the plan state accepts (`HOLD_FAMILIES` filtered by
`planCommandProblem`), the reusable facts (artifact commit, whether it is an
ancestor of the landing HEAD, whether its checks passed, the owned worktree's
unmerged commits and uncommitted edits, whether the worker session still exists)
and `recommend()`'s advice. Item keys hash plan, task, state and reason, so a
changed condition is a new item.

Delivery, each tick, only while Architect contact is `enabled` and the scheduler
holds the lease:

```
collect() ──> every item covered by the latest bundle? ──yes──> nothing
     │                      (pending, or delivered < RECOVERY_REPRAISE_MS ago)
     no
     v
receiver(): live Architect among plan owners, notice recipients, continuations,
            task submitters; none -> ensureArchitectOwner (existing continuation path)
     v
runner_outbox row  id = hash(project, generation, item keys)   INSERT OR IGNORE
+ RECOVERY_BUNDLE_RAISED on the anchor plan (same transaction, generation checked)
     v
OutcomeDelivery.deliver(): one coalesced notice to that session; the replaced
bundle's queued notice is cancelled, a pending one is superseded
```

Exactly once: the generation is read and the row inserted in one transaction under
the scheduler fence, and the id is deterministic, so a restart or a second
reconciler finds the generation taken. A bundle whose Architect is gone is
superseded and retried after `RECOVERY_RETRY_MS`. While paused nothing is
created; the set is recomputed from state, so it is retained. A delivered bundle
that stays unanswered is replaced by a new one after `RECOVERY_REPRAISE_MS` (6h).

Authority: plan ownership is advisory. Any live Architect of the project may command
a plan, and the command adopts it (`OWNER_ADOPTED`), so the bundle needs no
handover for plans owned by archived or cold sessions.

Observable: the `RECOVERY_BUNDLE_RAISED` event (count, keys, session, replaced
bundle) and `RecoveryBundles.status()` (items waiting, open bundle state and count).
