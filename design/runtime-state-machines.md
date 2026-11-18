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
| Retained verification | `retainedVerificationMachine` | `lz_runner_transition('retained', state, event)`        | Complete phase checks; explicitly continue an exact settled retained check; or cancel a held generation before a fresh generation                                                                          |
| Verification resource | `verificationResourceMachine` | `lz_runner_transition('resource', state, event)`        | Confirm native creation/removal; re-observe uncertain resources                                                                                                                                            |
| Verification check    | `verificationCheckMachine`    | `lz_runner_transition('check', state, event)`           | Resolve intended/uncertain execution from its bound receipt; restore an unstarted authorized retry on cancellation                                                                                         |
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
command results and cleanup are retained separately. A `retry-authorized` check
returns to `completed` only when cancellation proves its original receipt and
resource settlement remain unchanged before execution begins.

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

## Explicit continuation of an interrupted retained combined check

`continue-retained-check` is a current-owner control for one exact combined check
in a held retained-verification generation. It qualifies only a completed
non-timeout interruption receipt whose command phases and process group/tree are
conclusively settled, whose isolated resources are removed, and whose exact
accepted task, combined candidate, specification, command, environment and owner
bindings still match. It uses the current unchanged timing
policy. The operation must remain held; subprocess cancellation in a receipt is
not the same as intentional cancellation of the operation or plan.

Authorization is recorded before the check becomes runnable. Its receipt uses a
new operation-bound path and is appended to immutable retained-check receipt
history; it never overwrites the interrupted receipt or prior passing task and
combined receipts. Recovery runs only the named isolated check and reuses the
other matching passes. Reopen, exact request replay, concurrent authorization,
lost replies, stale bindings or late cancellation cannot duplicate execution or
publish success after the operation fence is lost. This control preserves task
acceptance and the retained generation/candidate; it does not certify the
original worker idle, or authorize cleanup.
Inspection offers the action only when its recorded check set supports that exact
next step. Full authorization rechecks ownership, plan/specification and
candidate inputs, all relevant check receipts, resources, activities, adoptions
and unresolved effects across the asynchronous admission boundary.

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

- `settleSupersededRetainedVerification()` closes an older held verification
  when an exact, authorized `ATTEMPT_RESUMED` replaces its input on the same
  attempt, session and workspace. It requires settled checks, uses the existing
  XState cancellation transition, and retains the operation and check history.
  Accepted candidates and retained repairs keep their existing gates.
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
if the plan version is still current.

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
