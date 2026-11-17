# Native workspace review and recovery

OpenCode 2.2.5 owns worktree creation, inventory, registration, refresh and
removal. Do not use `git worktree add/remove`, filesystem deletion, a custom
worktree registry, or forced removal for runner/review resources. New project
worktrees belong under `<canonical-project-root>.worktrees`; for this repository
that is `/Users/tjw/Documents/ChatGPT/opencode-lazers.worktrees`.

## Create or recover a review checkout

Run the following in an OpenCode plugin context for the canonical project. Supply
the reviewed commit from the durable task/plan or review record and a unique
review name. The native result's `directory` is authoritative: retain it even if
the native strategy adjusts the leaf to resolve a collision.

```ts
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect } from "effect"

const canonicalRoot = realpathSync(ctx.location.project.canonical)
const parent = resolve(`${canonicalRoot}.worktrees`)
const created = await Effect.runPromise(
  ctx.worktree.create({
    projectID: ctx.location.project.id,
    from: AbsolutePath.make(canonicalRoot),
    branch: reviewedCommit,
    directory: AbsolutePath.make(parent),
    name: reviewName,
  }),
)
const actualDirectory = created.directory
```

Inspect `actualDirectory` with Git before reviewing. Confirm its `HEAD` is the
recorded commit and inspect its status. If a temporary review checkout vanished,
recreate only the committed composition from its recorded commit. The source may
be restored from Git; uncommitted check logs from the vanished checkout are not
recoverable from that commit. Their absence is not proof that checks passed or
that a task was accepted. Rerun authorized checks and retain their new evidence.

## Clean up an owned review checkout

Only remove the exact `actualDirectory` returned above after confirming it is the
resource this review owns, no native session is active there, the tree is clean,
and its `HEAD` is already integrated into the reviewed target. Refresh and inspect
native inventory first. The native API call is non-forced:

```ts
await Effect.runPromise(
  ctx.worktree.remove({
    projectID: ctx.location.project.id,
    directory: AbsolutePath.make(actualDirectory),
    force: false,
  }),
)
```

If removal fails or its response is lost, retain the recorded path and reconcile
with fresh native inventory before retrying. Do not infer success from a surviving
branch or assume a missing directory means a native removal receipt. Preserve
dirty, unmerged, active, or uncertain resources for explicit reconciliation.
Runner cleanup also retires only the exact cleaned native location through the
supported host lifecycle.

## Verify a sealed source-quarantined candidate

Use the registered `lz-plan-command` action `verify-retained` as the current
same-project Architect. Supply the current `projectID`, `planRevision`,
`taskID`/`taskRevision`, latest `attemptID`, exact committed `artifact`, and a
reason. A `running` plan may use this route for a candidate belonging to the exact
latest `verifying` attempt. Existing stopped/accepted-plan verification remains
available; if its attempt has a source-quarantine record, that record must meet
the same exact authority checks rather than falling through to legacy admission.
The source quarantine must be sealed, unheld, bound to the original
request/session/assignment/workspace and immutable review-input binding, and have
an installed source guard. The recorded requester may differ from the current
owner only when the current same-project Architect owner is authorized for the
plan and the durable plan history proves an ordered `OWNER_CONTINUED` or
`OWNER_REASSIGNED` path from that requester after the original attempt began.
This continuity grants current verification authority only: it does not rewrite
the original requester, quarantine request, or review-input pin. Stale owners or
unproven/contradictory transfer history remain denied. Pending, held, absent-guard,
or otherwise mismatched quarantine facts do not authorize verification. Admission,
isolated checks, and result publication retain the current owner/control-epoch
fences, including across reopen. An active source-only operation remains valid if
supported reconciliation changes its plan from `running` to `blocked`, provided
the exact source authority and original verifying attempt remain unchanged.

The action runs only the task's declared checks in a separate retained-verification
checkout. It does not prompt or replay the original worker, or run checks in or
alter its checkout. It does not settle original uncertain effects, infer
background idleness, release the source/resource holds, or authorize original-
checkout cleanup. Passing task checks can accept the task node, but combined-plan
acceptance remains a separate gate. Failed checks retain their receipts without
changing the original source assignment or holds. A lost response is retried with
the same `requestID` and exact bindings so the original operation and receipts
are reused.

This route is not original execution settlement or safe cleanup. Keep the source
quarantine and historical holds intact; ordinary cleanup removes the checkout
only when it is contained, clean and idle.

## Clean up an owned worktree

A worktree is removed through the native worktree API, never forced, when all
three observed facts hold:

1. **Contained.** Its change is contained in the current checkout. The accepted
   artifact passes `proofForArtifact`, and the worktree's `HEAD` is an ancestor
   of the checkout or its change is contained there (rebased, amended, re-signed
   or squashed).
2. **Clean.** `git status --porcelain` is empty.
3. **Idle.** The host reports the worker idle now (see below).

Otherwise the worktree stays registered and the plan keeps a visible reason:
`Owned worktree is dirty`, `Owned worktree has unmerged commits`, or
`Owned worktree worker is not idle` with each live blocker named. A cancelled
plan follows the same rule; a clean worktree that never committed, or whose
commits are contained, is removed, and unmerged commits are preserved and
surfaced in the plan reason.

### Live idle check

A worker is idle when the host says so at the time of the check. No hook report
or stored evidence is read or waited for:

| Fact                         | Source                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| session not busy             | `client.session.active()`                                        |
| no pending input             | `client.session.inbox.list`                                      |
| no pending permission/forms  | `client.permission.request.list`, `client.form.list`             |
| no running shell in the tree | `client.shell.list`, status `running`, `cwd` inside the worktree |
| no active child session      | active sessions whose `parentID` chain reaches the worker        |

`RunnerHost.session()` returns these as `busy`, `pendingInput`,
`pendingPermissions`, `pendingForms`, `runningShells` and `activeChildren`.
A transport failure throws and the next tick asks again; a worker whose session
is authoritatively absent has nothing running. The `experimental.idle` hook only
wakes the scheduler and requests the handoff reminder. `runner_native_idle` is no
longer written; existing rows are history.

### Retry

The scheduler re-checks a held cleanup only when an observed fact changed: the
local fact set (attempts, effects, owners, source receipts, adoption checks)
differs from the last probe, or the poll interval elapsed (5 seconds when the
blocker was live activity, 60 seconds otherwise). A repeated, unchanged blocker
records no new `CLEANUP_BLOCKED` transition and appends no receipt history.
There is no owner authorization to obtain: when the blocker clears, cleanup
completes on its own. To act sooner, commit or discard the held worktree's
uncommitted work, merge its unmerged commits, then re-record integration with
`integrated`, or cancel the plan.

Existing retained runner paths and Root-owned review resources are not disposable
fixtures. In particular, preserve `lz182-review-recovered` and
`lz184-review-recovered` and their exact native registrations unless their owner
separately authorizes a reviewed cleanup.

## Extend a settled verification deadline

Checks default to 15 minutes without real stdout/stderr progress and a 60-minute
total hard backstop, shared across recognized command phases. Project options
`verificationInactivityTimeoutMs` and `verificationHardTimeoutMs`, or per-check
`inactivityTimeoutMs` and `hardTimeoutMs`, override the defaults. Legacy
`timeoutMs` remains readable as authored history but never controls current
execution. Receipts and inspection distinguish authored timing, resolved limits,
amendment provenance and the actual timeout cause without exposing check output.

Inspect the exact task, combined or retained check receipt first. Only the current
plan owner may use `extend-verification-deadline`, and only after the candidate is
unchanged, the timeout receipt is conclusive, and every relevant process and
resource obligation has settled. Bind `projectID`, `planRevision`, current
`expectedVersion`, `verificationPhase`, `checkID` and exact `artifact`. Task
checks also require `taskID`, `taskRevision` and latest `attemptID`; retained
continuation additionally requires exact `retainedVerificationID` and
`retainedGeneration`. Choose strictly larger effective inactivity and/or hard
limits, with inactivity no greater than the hard backstop.

For ordinary task and combined checks, the amendment does not change the authored
plan/task, acceptance evidence, candidate or original receipt and does not itself
start work; separately `resume` the same task attempt or combined candidate. For
an exact held or cancelled-held retained timeout, the same owner command is also
explicit authorization to continue only that isolated check. The runtime retains
passing and prior failed/interrupted receipts, the accepted task gate, original
quarantine and cleanup/resource obligations. It does not change the candidate,
command or acceptance, or prompt/replay the implementation worker. If any owner,
operation, generation, phase, check, command, receipt, process or resource binding
is stale or uncertain, leave the operation held for reconciliation.
