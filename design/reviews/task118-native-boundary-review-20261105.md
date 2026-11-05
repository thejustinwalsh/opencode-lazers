# LZ118 native error-boundary review

In-progress original worker: `ses_8a19b036a82f42599a1d978220fb871a`, attempt
`50345fa1-fccf-4cb7-9e85-e459ec1f85d9`. This records a reproduced finding at
`1793876109068`; subsequent worker changes require fresh review.

The startup classifier accepts only the HTTP protocol `WorktreeError` envelope
(`name`, `_tag`, `data.message`). The native adapter calls in-process
`ctx.worktree.create`. The pinned [PluginHost](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/host.ts#L573)
directly forwards that call to the core worktree service. It does not map errors
through the HTTP handler. The [core service](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/worktree.ts)
can return core typed errors, including `Worktree.OperationError` and
`Worktree.DirectoryUnavailableError`.

Root's one-shot reproduction imports the installed `Worktree.OperationError`,
passes actual failures through `Effect.runPromise`, then calls the worker's actual
classifier. Results:

| Failure shape                                   | Recognized |
| ----------------------------------------------- | ---------- |
| Installed core `Worktree.OperationError`        | false      |
| Pinned directory-unavailable tagged-error shape | false      |
| HTTP `WorktreeError` envelope                   | true       |

Script: `/private/tmp/lazers-startup-native-error-shape-review-20261105.ts`.
This is a classifier/Effect boundary regression, not a live startup-settlement
qualification. Existing HTTP-only adapter tests do not cover the real plugin
boundary. Correct and test genuine native shapes before acceptance; keep unknown
transport/lossy cases honest. This finding does not reconstruct missing historical
fields or establish that old effects have settled.

Root sent the finding through Desktop; Architect attached blocking advice to the
original task and notified its owner. Delivery is not proof the worker consumed
or corrected it. Native source/behavior and final tests must establish correction.

## In-progress correction recheck

At `1793877427994`, Root reran the actual classifier after the worker added core
error handling. The installed canonical `Worktree.OperationError` still returned
`recognized: false`; a directory error with the exact pinned class name returned
true; HTTP returned false. The classifier uses `instanceof` against the worker's
separately installed schema package. The reproduction loads the canonical schema
package, so constructor identity differs across real package copies. This remains
a boundary regression; same-package unit fixtures alone cannot establish the
host/plugin behavior. Constructor names likewise should not establish terminal
operation identity. Preserve structured native failure information and unknown
transport outcomes.

Recheck script: `/private/tmp/lazers-startup-native-error-shape-recheck-20261105.ts`.
Root queued this finding in Desktop for the existing same-worker review flow;
no worker/canonical source edits or extra acceptance claims.

## Cache retirement review

The in-progress `nativeHost.retireWorktreeLocation` uses
`session.list({ archived: false, directory })` and treats any result as an active
session. Unarchived history is not active execution. At `1793878102319`, the
completed LZ133 worker `ses_9250c22e68da40ff86371b407b9c3c11` was still unarchived
and located at its legitimately removed checkout; the native active-session
observations exclude it. This is a real retained-history counterexample, not a
reason to archive or delete its history. The new fixture calls its session-list
entries `activeSessionDirectories`, hiding the distinction.

As written, routine completed-worker history prevents cache eviction, leaving the
stale-location problem unfixed for that normal lifecycle. Cache-retirement refusal
is recorded separately and does not invalidate cleanup or acceptance; preserve
that separation. Check actual native active execution for the location and retain
session history. This finding is from the in-progress source and requires fresh
review after the worker finishes.

## Structural classifier recheck

At `1793878175613`, the independent cross-package reproduction against the
worker's revised structural classifier returned true for the actual separately
loaded `Worktree.OperationError` and the pinned directory-unavailable class, and
false for the HTTP envelope. The constructor-identity regression is corrected
in this source revision. This narrow check does not establish adapter, recovery,
whole-suite or native-product acceptance; the cache-retirement finding remains
open pending later changes.

## Committed-worker continuation regression

The broad worker run at `1793878582019` returned 254 passes, four failures and
one error. Focused reruns reproduced the existing resumed-worker/new-commit and
lost-prompt-response/committed-worker tests. Root source review found that
`prepareWorker` unconditionally calls `startupWorkspaceReady`, whose completed
worktree-receipt branch requires current HEAD to equal `attempt.base_commit`.
That rejects legitimate worker-produced commits on continuation. Creation-time
source validation must remain scoped to creation/recovery; it must not become a
general attempt freshness gate. Preserve these regression expectations and old
attempt baselines. Root sent this diagnosis through Desktop's existing review
flow. Subsequent source and test results must establish the correction.

## Cross-package test portability

The added `native.test.ts` cross-package fixture derives canonical `node_modules`
from `git-common-dir`, then asserts its error constructor differs from the local
one. In a normal main checkout those paths identify the same package, so this
assertion fails after integration. Use a real independent temporary fixture in
either checkout, with ordinary cleanup; do not skip it on main. Root also verified
that Bun resolves a file URL with a query suffix to the same module/constructor,
so a query suffix alone does not create an independent copy here. Sent through
Desktop for the existing review.
