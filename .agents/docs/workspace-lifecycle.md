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

Existing retained runner paths and Root-owned review resources are not disposable
fixtures. In particular, preserve `lz182-review-recovered` and
`lz184-review-recovered` and their exact native registrations unless their owner
separately authorizes a reviewed cleanup.
