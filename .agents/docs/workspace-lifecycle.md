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

## Verify a commit

Use the registered `lz-plan-command` action `verify-retained` as a live Architect
of the project. Supply the current `projectID`, `planRevision`,
`taskID`/`taskRevision`, latest `attemptID`, exact committed `artifact`, and a
reason. The plan must be blocked, accepted or cleanup-blocked. The call binds no
plan version, generation or authorization: other work on the plan moves the
version without changing the candidate.

The action runs the task's declared checks on that commit in a temporary
retained-verification checkout and records pass or fail. It does not prompt or
replay the original worker, run checks in or alter its checkout, settle its
effects, infer background idleness, or authorize original-checkout cleanup. A pass
accepts the task node and runs a plan stopped on that task's failure again; the
ordinary combined check is the plan's acceptance. A failure keeps its receipts,
notifies the Architect and changes nothing else; run `verify-retained` again once
the cause is fixed. A lost response is retried with the same `requestID` and exact
bindings so the original operation and receipts are reused. Ordinary cleanup
removes the checkout only when it is contained, clean and idle.

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

## Verification timing

Checks have no deadline by default; they run until they exit or are cancelled.
Project options `verificationInactivityTimeoutMs` and `verificationHardTimeoutMs`,
or per-check `inactivityTimeoutMs` (reset by real stdout/stderr progress) and
`hardTimeoutMs` (shared across recognized command phases), set one. Legacy
`timeoutMs` remains readable as authored history but never controls current
execution. Receipts and inspection distinguish authored timing, resolved limits,
amendment provenance and the actual timeout cause without exposing check output.

A timed-out or interrupted check is a failed check. There is no deadline-extension
command: raise the project or per-check limit in the authored check, then re-run
the check (`resume` for a blocked plan's combined check, `verify-retained` for a
retained candidate).
