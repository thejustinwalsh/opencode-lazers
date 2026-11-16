# Runner state machines and recovery

`src/runner/lifecycle-machines.ts:lifecycleMachines` is the shared XState registry.
It contains the existing task, dispatch-control and Architect-source machines and
the persisted runner lifecycle machines below. State values remain compatible
with existing records. No task snapshots or attempt history are replaced.

| Domain                | XState definition             | Persisted update path                                   | Recovery / completion                                                                                                                        |
| --------------------- | ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Task                  | `taskMachine`                 | `RunnerStore.move()`                                    | Reconcile, resume, retry, retained repair/acceptance, cancellation or incorporation                                                          |
| Plan                  | `planMachine`                 | `lz_runner_transition('plan', state, event)`            | Owner commands; cleanup probes; integration or cancellation                                                                                  |
| Attempt               | `attemptMachine`              | `lz_runner_transition('attempt', state, event)`         | Resume/retry; cancellation preserves the previous attempt and checkout                                                                       |
| Effect                | `effectMachine`               | `lz_runner_transition('effect', state, event)`          | Reconcile a native receipt, or record conclusive failure; never replay an unknown side effect                                                |
| Dispatch              | `dispatchControlMachine`      | `RunnerStore.setDispatchPause()`                        | Explicit unpause or recorded integration conditions                                                                                          |
| Architect source      | `architectSourceMachine`      | `architectSourceTransition()`                           | Prepare, activate or retire                                                                                                                  |
| Architect renewal     | `renewalMachine`              | `lz_runner_transition('renewal', state, event)`         | Continue creation/archive, recover input, roll back or defer; retry deferred creation                                                        |
| Outcome delivery      | `outboxMachine`               | `lz_runner_transition('outbox', state, event)`          | Observe admission/consumption, reconcile uncertainty, supersede or retarget through existing owner controls                                  |
| Descendant adoption   | `adoptionMachine`             | `lz_runner_transition('adoption', state, event)`        | Revalidate checks, supply required acceptance, accept or cancel a held operation                                                             |
| Retained verification | `retainedVerificationMachine` | `lz_runner_transition('retained', state, event)`        | Complete phase checks/acceptance; explicitly continue an exact settled retained check; or cancel a held generation before a fresh generation |
| Verification resource | `verificationResourceMachine` | `lz_runner_transition('resource', state, event)`        | Confirm native creation/removal; re-observe uncertain resources                                                                              |
| Verification check    | `verificationCheckMachine`    | `lz_runner_transition('check', state, event)`           | Resolve intended/uncertain execution from the operation-bound receipt                                                                        |
| Check cleanup         | `verificationCleanupMachine`  | `lz_runner_transition('cleanup', cleanup_state, event)` | Retry failed cleanup; record confirmed completion separately from check success                                                              |

`lifecycleTransition()` resolves the persisted row state through XState and uses
`current.can()` and XState's pure `transition()` before returning the next state.
The SQLite bridge evaluates against the row being updated inside the existing
transaction. Existing owner/version/attempt/resource predicates remain in their
handlers. `registerLifecycleTransitions()` installs the bridge once per connection;
`RunnerStore.atomic()` reinstalls it after a closed connection reopens.
`validateRetainedLifecycles()` also validates workspace and operation-cleanup
fields before saving the retained operation payload. Retained
verification's standalone store also registers it through its schema entry point.

Initial inserts use each machine's declared initial state. Native observations
such as `ArchitectSourceResult.state` describe OpenCode results; they are not
runner transition authority. `verificationCheckMachine` permits a previously
completed command to become uncertain when subprocess settlement changes;
command results and cleanup are retained separately.

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
accepted task, combined candidate, specification, command, environment, owner and
source-quarantine bindings still match. It uses the current unchanged timing
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
original worker idle, unseal its source, settle quarantine, or authorize cleanup.
Inspection offers the action only when its recorded check set supports that exact
next step. Full authorization rechecks ownership, plan/specification and
candidate inputs, all relevant check receipts, resources, activities, adoptions
and unresolved effects across the asynchronous admission boundary.

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
- `isolateStoppedWorkerSource()` invokes the existing source quarantine for a
  stopped worker with a completed, bound input and unknown background state
  when its isolated checkout blocks eligible isolated work. Native archive and
  source guard checks must succeed before the reservation is excluded. The
  checkout and unresolved resources stay owned; no completion is recorded.
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

The resumed LZ-154 worker reached verification. Its runner check timeout then
exposed a second reservation hold: a settled timeout kept the stopped worker's
source reserved. `hasSettledVerificationTimeout()` now admits that exact
blocked artifact to the same guarded source quarantine. The timeout remains a
failed check; resource settlement and native source isolation are distinct from
task acceptance. A real subprocess-timeout regression confirms the queued
overlapping task starts and the original checkout remains intact.

After Desktop Relaunch, native transitions recorded LZ-154's
`SOURCE_QUARANTINE_SEALED` at 08:18:25 and LZ-203's `WORKER_STARTED` at
08:18:31 America/Detroit. The native session inventory and Desktop Tasks
confirmed LZ-203 running without a Start action. `advanceAttempt()` now leaves
quarantined attempts to the retained verification workflow instead of trying
mechanical edits on their protected source and replacing the original hold.

On November 11, the LZ-203 Architect received
`Permission.DeclinedError` at 10:37:26 EST while OpenCode was reloading
loaded locations. Reload finished at 10:37:39 EST. The activation helper had
checked for open requests and in-flight tools but admitted an active session
between tool calls. For a live service-wide reload, wait for the native active
session inventory to clear. OpenCode can decline a call as its location
permission service closes. Retry the unchanged command after reload completes
if the plan version is still current.
