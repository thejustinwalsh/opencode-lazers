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

## Recover a held runner cleanup

Use the registered `recover-cleanup` action as the current plan owner, bound to the
exact `planID`, accepted `taskID`, `attemptID`, integrated `artifact`, and
`targetBranch`. Preserve the existing assignment and workspace; recovery is not a
new worker run or a replay of implementation or verification.

Removal requires a stable native settlement tied to that exact assignment: a
confirmed successful terminal event and an uninvalidated `experimental.idle`
report for the assigned input with zero shell, subagent, and image jobs. The idle
hook's report covers background work owned by the worker and its descendants.
An empty active-session map, an empty location shell list, a successful terminal,
or a read-only `session.shell` check alone cannot establish that complete
background inventory.

If the report is absent, stale, positive, contradictory, or changes during the
read, cleanup remains held: the exact worktree stays registered, no location is
retired, and prior uncertainty is retained. Do not repeat `recover-cleanup` on
unchanged evidence. Wait only for the original native lifecycle to produce a
genuine, exact idle observation after its background work settles, then have the
current owner retry with the same task, attempt, artifact, workspace, and branch
bindings. `session.shell` is not a way to manufacture this evidence: it starts a
shell, publishes shell events and a non-resuming synthetic notice, but does not
run the `experimental.idle` hook or expose image/descendant job inventory. If no
such native idle observation is available, keep the hold and ask the Architect to
choose a supported next step; do not edit native state directly, force removal,
replace the worker, or replay its implementation prompt.

Existing retained runner paths and Root-owned review resources are not disposable
fixtures. In particular, preserve `lz182-review-recovered` and
`lz184-review-recovered` and their exact native registrations unless their owner
separately authorizes a reviewed cleanup.

## Extend a settled verification deadline

Inspect the exact task or combined check receipt first. Only the current plan
owner may use `extend-verification-deadline`, and only after the plan is stopped,
the candidate is unchanged, the timeout receipt is conclusive, and every check
process and owned resource has settled. Bind `projectID`, `planRevision`, the
current `expectedVersion`, `verificationPhase`, `checkID`, and exact `artifact`;
task checks additionally require `taskID`, `taskRevision`, and latest `attemptID`.
Choose a strictly larger `timeoutMs` than the current effective allowance.

Extension appends a deadline amendment; it does not change the authored plan or
task, acceptance/evidence requirements, candidate, or original check receipt. It
does not start work or grant acceptance. After the amendment is recorded, the
owner must issue a separate `resume` bound to the same task attempt, or a
plan-level resume for the same combined candidate. The runtime preserves passing
receipts, reruns only checks that need the amended policy, and never restarts or
prompts the implementation worker. If any binding, receipt, process or resource
is uncertain, leave the candidate stopped for reconciliation instead.
