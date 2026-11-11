# Runner state machines and recovery

`src/runner/lifecycle-machines.ts:lifecycleMachines` is the shared XState registry.
It contains the existing task, dispatch-control and Architect-source machines and
the persisted runner lifecycle machines below. State values remain compatible
with existing records. No task snapshots or attempt history are replaced.

| Domain                | XState definition             | Persisted update path                                   | Recovery / completion                                                                                       |
| --------------------- | ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Task                  | `taskMachine`                 | `RunnerStore.move()`                                    | Reconcile, resume, retry, retained repair/acceptance, cancellation or incorporation                         |
| Plan                  | `planMachine`                 | `lz_runner_transition('plan', state, event)`            | Owner commands; cleanup probes; integration or cancellation                                                 |
| Attempt               | `attemptMachine`              | `lz_runner_transition('attempt', state, event)`         | Resume/retry; cancellation preserves the previous attempt and checkout                                      |
| Effect                | `effectMachine`               | `lz_runner_transition('effect', state, event)`          | Reconcile a native receipt, or record conclusive failure; never replay an unknown side effect               |
| Dispatch              | `dispatchControlMachine`      | `RunnerStore.setDispatchPause()`                        | Explicit unpause or recorded integration conditions                                                         |
| Architect source      | `architectSourceMachine`      | `architectSourceTransition()`                           | Prepare, activate or retire                                                                                 |
| Architect renewal     | `renewalMachine`              | `lz_runner_transition('renewal', state, event)`         | Continue creation/archive, recover input, roll back or defer; retry deferred creation                       |
| Outcome delivery      | `outboxMachine`               | `lz_runner_transition('outbox', state, event)`          | Observe admission/consumption, reconcile uncertainty, supersede or retarget through existing owner controls |
| Descendant adoption   | `adoptionMachine`             | `lz_runner_transition('adoption', state, event)`        | Revalidate checks, supply required acceptance, accept or cancel a held operation                            |
| Retained verification | `retainedVerificationMachine` | `lz_runner_transition('retained', state, event)`        | Complete phase checks/acceptance or cancel a held generation before a fresh generation                      |
| Verification resource | `verificationResourceMachine` | `lz_runner_transition('resource', state, event)`        | Confirm native creation/removal; re-observe uncertain resources                                             |
| Verification check    | `verificationCheckMachine`    | `lz_runner_transition('check', state, event)`           | Resolve intended/uncertain execution from the operation-bound receipt                                       |
| Check cleanup         | `verificationCleanupMachine`  | `lz_runner_transition('cleanup', cleanup_state, event)` | Retry failed cleanup; record confirmed completion separately from check success                             |

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
